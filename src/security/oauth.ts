import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Router, urlencoded, type RequestHandler } from "express";
import Provider, { errors, type Configuration } from "oidc-provider";

import { defaultClients, type TrustedClient } from "../config/clients.js";
import {
  profileFromScopes,
  profileScopes,
  workspaceScopes,
  type AccessProfile,
} from "./permissions.js";
const SCOPE = workspaceScopes.join(" ");
const OWNER = "workspace-owner";
const digest = (text: string) => createHash("sha256").update(text).digest();
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export interface OAuthSettings {
  issuer: string;
  clients?: TrustedClient[];
  jwks: NonNullable<Configuration["jwks"]>;
}

/** A single-owner authorization service. Grants deliberately expire on restart. */
export function createOAuth(settings: OAuthSettings, ownerToken: string) {
  const issuer = settings.issuer;
  const clients = settings.clients ?? defaultClients;
  const clientForCallback = (redirect: unknown) =>
    clients.find((client) => client.redirect_uri === redirect);
  const trustedIdentity = (id: string) =>
    clients.some((client) => client.metadata_url === id);
  const callbackOrigins = [
    ...new Set(clients.map((client) => new URL(client.redirect_uri).origin)),
  ].join(" ");
  const resource = `${issuer}/mcp`;
  const expected = digest(ownerToken);
  const provider = new Provider(`${issuer}/oauth`, {
    jwks: settings.jwks,
    cookies: {
      keys: [
        createHmac("sha256", ownerToken)
          .update("oauth-cookies-v1")
          .digest("base64url"),
      ],
      long: { secure: true, httpOnly: true, sameSite: "lax" },
      short: { secure: true, httpOnly: true, sameSite: "lax" },
    },
    features: {
      devInteractions: { enabled: false },
      clientIdMetadataDocument: {
        enabled: true,
        ack: "draft-02",
        // Resolve only the published identity we support; preserve the library's
        // HTTPS, response-size, redirect, client-id and private-IP checks.
        allowFetch: (_ctx, clientId) => trustedIdentity(clientId),
        allowClient: (_ctx, client) => trustedIdentity(client.clientId),
        cacheDuration: { min: 60, max: 3600 },
      },
      registration: { enabled: true },
      registrationManagement: { enabled: false },
      revocation: {
        enabled: true,
        allowedPolicy: (_ctx, client, token) =>
          token.clientId === client.clientId,
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, requested) => {
          if (requested !== resource) throw new errors.InvalidTarget();
          return {
            scope: SCOPE,
            audience: resource,
            accessTokenTTL: 3600,
            accessTokenFormat: "opaque",
          };
        },
      },
    },
    fetchResponseBodyLimits: { "client_id metadata document": 16384 },
    // Restrict registrations to operator-configured client identities and exact callbacks.
    extraClientMetadata: {
      properties: ["workspace_policy", "token_endpoint_auth_methods_supported"],
      validator: (_ctx, _key, _value, metadata) => {
        // Claude's shared metadata also declares JWT bearer. Keep only the
        // authorization-code/refresh subset this service actually implements.
        const transition = metadata as typeof metadata & {
          token_endpoint_auth_methods_supported?: unknown;
        };
        // Some trusted CIMD documents advertise multiple methods during the transition.
        // Select public-client auth only when the document explicitly supports it.
        if (
          typeof metadata.client_id === "string" &&
          trustedIdentity(metadata.client_id) &&
          Array.isArray(transition.token_endpoint_auth_methods_supported) &&
          transition.token_endpoint_auth_methods_supported.includes("none")
        ) {
          metadata.token_endpoint_auth_method = "none";
          delete metadata.token_endpoint_auth_signing_alg;
          delete metadata.jwks;
          delete metadata.jwks_uri;
        }
        const declaredGrants = metadata.grant_types;
        if (
          Array.isArray(declaredGrants) &&
          declaredGrants.includes("authorization_code") &&
          declaredGrants.every((grant) =>
            [
              "authorization_code",
              "refresh_token",
              "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ].includes(grant),
          )
        ) {
          metadata.grant_types = declaredGrants.filter((grant) =>
            ["authorization_code", "refresh_token"].includes(grant),
          );
        }
        if (
          metadata.redirect_uris?.length !== 1 ||
          !clientForCallback(metadata.redirect_uris[0]) ||
          (typeof metadata.client_id === "string" &&
            trustedIdentity(metadata.client_id) &&
            clients.find((client) => client.metadata_url === metadata.client_id)
              ?.redirect_uri !== metadata.redirect_uris[0]) ||
          !["none", "client_secret_basic", "client_secret_post"].includes(
            metadata.token_endpoint_auth_method ?? "client_secret_basic",
          ) ||
          metadata.response_types?.some((x) => x !== "code") ||
          metadata.grant_types?.some(
            (x) => !["authorization_code", "refresh_token"].includes(x),
          ) ||
          metadata.jwks_uri ||
          metadata.jwks ||
          metadata.sector_identifier_uri ||
          (Array.isArray(metadata.request_uris) && metadata.request_uris.length)
        ) {
          throw new errors.InvalidClientMetadata(
            "Only configured web-client callbacks and supported client authentication methods are allowed.",
          );
        }
      },
    },
    responseTypes: ["code"],
    scopes: ["openid", "offline_access"],
    pkce: { required: () => true },
    rotateRefreshToken: true,
    // The owner explicitly approves ongoing workspace access on our consent page.
    issueRefreshToken: (_ctx, client, source) =>
      client.grantTypeAllowed("refresh_token") && source.accountId === OWNER,
    ttl: {
      AccessToken: 3600,
      AuthorizationCode: 60,
      Interaction: 600,
      Session: 28800,
      Grant: 28800,
      RefreshToken: 28800,
    },
    findAccount: (_ctx, accountId) =>
      accountId === OWNER
        ? { accountId, claims: () => ({ sub: accountId }) }
        : undefined,
    interactions: {
      url: (_ctx, interaction) =>
        `${issuer}/oauth/interaction/${interaction.uid}`,
    },
    renderError: (ctx) => {
      ctx.type = "text/plain";
      ctx.body =
        "Authorization request failed. Check the connector settings and start sign-in again.";
    },
  });
  provider.proxy = true;
  provider.on("server_error", () => console.error("OAuth request failed."));
  const router = Router();
  const forms = new Map<string, { csrf: string; expires: number }>();
  let windowStart = Date.now();
  let requests = 0;
  let failures = 0;
  let blockedUntil = 0;

  // One process, one owner: bound public traffic without trusting forwarded IPs.
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // no-referrer makes browsers send Origin: null on HTML form POSTs.
    // Keep same-origin form checks working without leaking URLs to Claude.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; form-action 'self' ${callbackOrigins}; frame-ancestors 'none'; base-uri 'none'`,
    );
    if (req.headers["x-forwarded-proto"] !== "https") {
      res.status(400).send("Use the configured HTTPS endpoint for sign-in.");
      return;
    }
    if (Date.now() - windowStart > 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 120) {
      res.setHeader("Retry-After", "60");
      res.status(429).end();
      return;
    }
    next();
  });
  router.get("/interaction/:uid", async (req, res) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (
        !["login", "consent"].includes(details.prompt.name) ||
        !clientForCallback(details.params.redirect_uri)
      ) {
        res.status(400).send("Unsupported authorization request.");
        return;
      }
      for (const [id, form] of forms)
        if (form.expires < Date.now()) forms.delete(id);
      if (forms.size >= 100) {
        res.status(429).end();
        return;
      }
      const csrf = randomBytes(32).toString("base64url");
      forms.set(details.uid, { csrf, expires: Date.now() + 600000 });
      const login = details.prompt.name === "login";
      const client = clientForCallback(details.params.redirect_uri)!;
      const requested = String(details.params.scope ?? "").split(" ");
      const profiles = (Object.keys(profileScopes) as AccessProfile[]).filter(
        (profile) => requested.includes(profileScopes[profile]),
      );
      if (!profiles.length) {
        res
          .status(400)
          .send(
            "Reconnect the connector with workspace:read, workspace:report, or workspace:edit scopes. Legacy grants must be reauthorized.",
          );
        return;
      }
      const labels = {
        inspect: "Inspect: read, search and Git review only",
        report:
          "Plan/report: inspect, write WORKFLOWS documents and project state, record handoffs",
        edit: "Edit: all fourteen tools, including moves, recoverable deletion and restoration",
      };
      const selection = login
        ? ""
        : `<label>Access profile <select name="profile">${profiles.map((profile) => `<option value="${profile}">${labels[profile]}</option>`).join("")}</select></label>`;
      res
        .type("html")
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize Secure MCP File Server</title><h1>Authorize ${escape(client.name)}</h1><p>Connect to your configured workspace. The recipient is <strong>${escape(new URL(client.redirect_uri).hostname)}</strong>.</p><p>Only approve a connection you started. Never enter your AI account password here. Permissions belong to this connection, including chats sharing it.</p><form method="post" action="/oauth/interaction/${escape(details.uid)}"><input type="hidden" name="csrf" value="${csrf}">${login ? '<label>Private MCP token <input name="owner_token" type="password" autocomplete="off" required maxlength="128"></label><p>Enter the private MCP token without the Bearer prefix.</p>' : `<p>You are signed in as the workspace owner.</p>${selection}`}<button name="decision" value="approve">Continue</button><button name="decision" value="deny" formnovalidate>Cancel</button></form></html>`,
        );
    } catch {
      res.status(400).send("Sign-in expired. Start again from your connector.");
    }
  });
  router.post(
    "/interaction/:uid",
    urlencoded({ extended: false, limit: "4kb", parameterLimit: 4 }),
    async (req, res) => {
      try {
        const details = await provider.interactionDetails(req, res);
        const form = forms.get(details.uid);
        const body = req.body as Record<string, unknown>;
        if (
          !form ||
          form.expires < Date.now() ||
          typeof body.csrf !== "string" ||
          !timingSafeEqual(digest(body.csrf), digest(form.csrf))
        ) {
          res.status(400).send("Invalid or expired authorization form.");
          return;
        }
        forms.delete(details.uid);
        if (body.decision === "deny") {
          await provider.interactionFinished(
            req,
            res,
            {
              error: "access_denied",
              error_description: "The owner declined access.",
            },
            { mergeWithLastSubmission: false },
          );
          return;
        }
        if (
          body.decision !== "approve" ||
          !clientForCallback(details.params.redirect_uri)
        ) {
          res.status(400).end();
          return;
        }
        if (details.prompt.name === "login") {
          if (Date.now() < blockedUntil) {
            res.status(429).send("Too many sign-in attempts. Try again later.");
            return;
          }
          if (
            typeof body.owner_token !== "string" ||
            !timingSafeEqual(digest(body.owner_token), expected)
          ) {
            if (++failures >= 5) {
              failures = 0;
              blockedUntil = Date.now() + 300000;
            }
            res
              .status(401)
              .send("Sign-in failed. Start again from your connector.");
            return;
          }
          failures = 0;
          await provider.interactionFinished(
            req,
            res,
            { login: { accountId: OWNER, remember: false } },
            { mergeWithLastSubmission: false },
          );
        } else if (
          details.prompt.name === "consent" &&
          details.session?.accountId === OWNER
        ) {
          const grant = new provider.Grant({
            accountId: OWNER,
            clientId: String(details.params.client_id),
          });
          grant.addOIDCScope("openid offline_access");
          const profile = body.profile;
          if (
            profile !== "inspect" &&
            profile !== "report" &&
            profile !== "edit"
          ) {
            res.status(400).send("Choose a valid access profile.");
            return;
          }
          const requested = String(details.params.scope ?? "").split(" ");
          if (!requested.includes(profileScopes[profile])) {
            res
              .status(400)
              .send("The selected profile was not requested by this client.");
            return;
          }
          grant.addResourceScope(resource, profileScopes[profile]);
          // Remember explicitly declined scopes so consent does not loop on a broad client request.
          grant.rejectResourceScope(
            resource,
            workspaceScopes.filter((scope) => scope !== profileScopes[profile]),
          );
          const grantId = await grant.save();
          await provider.interactionFinished(
            req,
            res,
            { consent: { grantId } },
            { mergeWithLastSubmission: true },
          );
        } else {
          res.status(400).send("Unsupported authorization request.");
        }
      } catch {
        res
          .status(400)
          .send("Sign-in expired. Start again from your connector.");
      }
    },
  );
  router.use(provider.callback() as RequestHandler);
  return {
    router,
    issuer: `${issuer}/oauth`,
    resource,
    metadataUrl: `${issuer}/.well-known/oauth-protected-resource/mcp`,
    metadata: {
      issuer: `${issuer}/oauth`,
      authorization_endpoint: `${issuer}/oauth/auth`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/reg`,
      client_id_metadata_document_supported: true,
      revocation_endpoint: `${issuer}/oauth/token/revocation`,
      jwks_uri: `${issuer}/oauth/jwks`,
      response_types_supported: ["code"],
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_post",
      ],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...workspaceScopes, "offline_access"],
    },
    async verify(token: string): Promise<AccessProfile | undefined> {
      const access = await provider.AccessToken.find(token);
      if (
        !access ||
        access.accountId !== OWNER ||
        access.aud !== resource ||
        typeof access.exp !== "number" ||
        access.exp <= Math.floor(Date.now() / 1000)
      )
        return undefined;
      return profileFromScopes(access.scopes);
    },
  };
}

export type OAuthService = ReturnType<typeof createOAuth>;
