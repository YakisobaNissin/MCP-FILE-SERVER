import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { Sandbox } from "../security/sandbox.js";
import { WorkspaceError } from "../security/errors.js";
import {
  appendPlanLogSchema,
  createCheckpointSchema,
} from "../tools/schemas.js";
import { appendTextFile, writeTextFile, readSnapshot } from "./text-files.js";

const storedLogSchema = appendPlanLogSchema.extend({
  format_version: z.literal(1),
  record_id: z.uuid(),
  created_at: z.iso.datetime(),
  project_state_path: z.literal("PROJECT_STATE.md"),
});

export async function appendPlanLog(
  sandbox: Sandbox,
  raw: z.input<typeof appendPlanLogSchema>,
) {
  const input = appendPlanLogSchema.parse(raw);
  const createdAt = new Date().toISOString();
  const record = {
    ...input,
    format_version: 1 as const,
    record_id: randomUUID(),
    created_at: createdAt,
    project_state_path: "PROJECT_STATE.md" as const,
  };
  const relative = `PLAN_LOG/${createdAt.slice(0, 10)}_${input.task_id}.jsonl`;
  await sandbox.ensureHandoffDirectory("PLAN_LOG");
  const result = await appendTextFile(
    sandbox,
    relative,
    JSON.stringify(record) + "\n",
    (existing) => {
      try {
        if (existing && !existing.endsWith("\n"))
          throw new Error("Incomplete JSONL");
        for (const line of existing.split("\n").filter(Boolean)) {
          const previous = storedLogSchema.parse(JSON.parse(line));
          if (previous.task_id !== input.task_id)
            throw new Error("Different task");
        }
      } catch {
        throw new WorkspaceError(
          "INVALID_LOG",
          "Existing log is malformed or belongs to another task; repair it before appending.",
        );
      }
    },
  );
  return {
    path: result.path,
    appended: true,
    record_id: record.record_id,
    created_at: createdAt,
    sha256: result.sha256,
  };
}

export async function createCheckpoint(
  sandbox: Sandbox,
  raw: z.input<typeof createCheckpointSchema>,
) {
  const input = createCheckpointSchema.parse(raw);
  const state = await readSnapshot(sandbox, "PROJECT_STATE.md");
  const createdAt = new Date().toISOString();
  const recordId = randomUUID();
  const record = {
    format_version: 1,
    record_id: recordId,
    created_at: createdAt,
    ...input,
    project_state_path: "PROJECT_STATE.md",
    project_state_sha256: state.sha256,
  };
  const relative = `CHECKPOINTS/${createdAt.replaceAll(":", "-")}_${input.task_id}_${recordId}.json`;
  await sandbox.ensureHandoffDirectory("CHECKPOINTS");
  const result = await writeTextFile(sandbox, {
    path: relative,
    content: JSON.stringify(record) + "\n",
  });
  return {
    path: result.path,
    created: true,
    record_id: recordId,
    created_at: createdAt,
    project_state_sha256: state.sha256,
    sha256: result.sha256,
  };
}
