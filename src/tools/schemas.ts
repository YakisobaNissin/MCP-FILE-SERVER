import { z } from "zod/v4";

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
