# Testing — M2

Run `npm run build`, `npm run typecheck`, `npm test`, and `npm run format:check`. For the transport workflow alone: `npm test -- tests/http.test.ts`.

Tests use isolated ignored fixtures, never real user projects. Coverage includes every tool, schema/path attacks, real junctions and hard links, binary/size/output limits, stale and simultaneous edits, exclusive creation, recoverable deletion, search budgets and content-free auditing. All six tools are discovered and exercised over real Streamable HTTP, including modern and legacy workflows.

On this Windows host, creating a file symlink returns EPERM without Developer Mode/symlink privileges. That single test explicitly skips with a reason; real junction tests still execute. No permission or security check is disabled.

M1 Inspector captures remain under `docs/evidence/` as historical M1 evidence, including its negative-case Windows CLI teardown assertion. M2 verification is the executed automated SDK HTTP suite; no new Inspector GUI or Codex connection is claimed. Minimal final counts are recorded in `docs/evidence/m2-verification.txt`.
