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
  if (error instanceof WorkspaceError) {
    return { code: error.code, message: error.message };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT")
    return {
      code: "NOT_FOUND",
      message: "The requested directory does not exist.",
    };
  if (code === "ENOTDIR")
    return {
      code: "NOT_DIRECTORY",
      message: "The requested path is not a directory.",
    };
  if (code === "EACCES" || code === "EPERM") {
    return {
      code: "ACCESS_DENIED",
      message: "The requested directory cannot be accessed.",
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "The operation failed. Check the local server configuration.",
  };
}
