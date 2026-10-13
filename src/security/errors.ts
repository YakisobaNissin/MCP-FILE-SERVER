import { ZodError } from "zod/v4";

/** Only these deliberately written messages may cross the MCP boundary. */
export class WorkspaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ZodError)
    return {
      code: "INVALID_INPUT",
      message: "Invalid tool arguments. Check the tool schema and size limits.",
    };
  if (error instanceof WorkspaceError) {
    return { code: error.code, message: error.message };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT")
    return {
      code: "NOT_FOUND",
      message: "The requested path does not exist.",
    };
  if (code === "ENOTDIR")
    return {
      code: "NOT_DIRECTORY",
      message: "The requested path is not a directory.",
    };
  if (code === "EACCES" || code === "EPERM") {
    return {
      code: "ACCESS_DENIED",
      message: "The requested path cannot be accessed.",
    };
  }
  if (code === "EEXIST")
    return {
      code: "ALREADY_EXISTS",
      message: "The target already exists. Overwriting is not supported.",
    };
  return {
    code: "INTERNAL_ERROR",
    message: "The operation failed. Check the local server configuration.",
  };
}
