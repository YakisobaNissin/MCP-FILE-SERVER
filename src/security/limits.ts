export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_INPUT_BYTES = 16 * 1024;
export const MAX_RESULT_BYTES = 32 * 1024;
export const MAX_READ_BYTES = 8 * 1024;
export const BINARY_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function fitsToolResult(result: object): boolean {
  return (
    Buffer.byteLength(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      }),
      "utf8",
    ) <= MAX_RESULT_BYTES
  );
}

export function validText(text: string): boolean {
  return (
    !BINARY_CONTROLS.test(text) &&
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(text),
    ) === text
  );
}
