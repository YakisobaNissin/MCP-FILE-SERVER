import { z } from "zod/v4";
import {
  MAX_INPUT_BYTES,
  MAX_FILE_BYTES,
  validText,
} from "../security/limits.js";

export const listFilesSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(512)
    .default(".")
    .describe("Relative directory. Use . for the workspace root."),
  recursive: z
    .boolean()
    .default(false)
    .describe("Include nested directories, up to 8 levels."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Maximum entries returned (1–100)."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(0)
    .describe(
      "Skip this many permitted entries. Use next_offset from the previous result.",
    ),
});

export type ListFilesInput = z.infer<typeof listFilesSchema>;

const filePath = z
  .string()
  .min(1)
  .max(512)
  .describe(
    "Workspace-relative file path; the parent directory must already exist.",
  );
const textInput = z
  .string()
  .max(MAX_INPUT_BYTES)
  .refine(
    (text) =>
      Buffer.byteLength(text, "utf8") <= MAX_INPUT_BYTES && validText(text),
    "Use valid UTF-8 text without binary controls, at most 16 KiB.",
  );
const sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("SHA-256 from a fresh read_file result; rejects stale changes.");

export const readFileSchema = z.strictObject({
  path: filePath,
  start_line: z.number().int().min(1).max(1_000_000).default(1),
  max_lines: z.number().int().min(1).max(500).default(200),
  start_column: z
    .number()
    .int()
    .min(0)
    .max(MAX_FILE_BYTES)
    .default(0)
    .describe(
      "Zero-based Unicode character offset in start_line. Use next_column for a partially returned line.",
    ),
});
export const writeFileSchema = z.strictObject({
  path: filePath,
  content: textInput,
});
export const strReplaceSchema = z.strictObject({
  path: filePath,
  old_text: textInput.refine(
    (text) => text.length > 0,
    "old_text must not be empty.",
  ),
  new_text: textInput,
  expected_sha256: sha256,
});
export const deleteFileSchema = z.strictObject({
  path: filePath,
  confirm: z
    .literal(true)
    .describe(
      "Explicitly authorize moving this file to private recovery storage.",
    ),
  expected_sha256: sha256,
});
export const searchFilesSchema = z.strictObject({
  path: z.string().min(1).max(512).default("."),
  query: z.string().min(1).max(256).refine(validText),
  mode: z.enum(["name", "text"]).default("text"),
  case_sensitive: z.boolean().default(false),
  max_results: z.number().int().min(1).max(100).default(20),
});

export const toolSchemas = {
  list_files: listFilesSchema,
  read_file: readFileSchema,
  write_file: writeFileSchema,
  str_replace: strReplaceSchema,
  delete_file: deleteFileSchema,
  search_files: searchFilesSchema,
};
export type ToolName = keyof typeof toolSchemas;
