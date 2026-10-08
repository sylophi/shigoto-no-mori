import type * as Schema from "effect/Schema";
import { z } from "zod";
import { DeviceIdSchema } from "@shared/hub/protocol";
import { HexId32Schema } from "@shared/ipc/hexId";
import {
  MirrorIgnoreModeSchema,
  MirrorIgnoresSchema,
  SyncCloneIntoSchema,
  SyncLandingRefSchema,
  SyncPullFilesSchema,
} from "@shared/ipc/modules/sync";
import { safeDecode } from "@shared/ipc/schema";
import { GitRefNameSchema, ProjectSchema } from "./project";
import { WorktreeIdSchema } from "./config";
import { CommitHashSchema, WorktreeSchema } from "./worktree";

// An Effect schema inside a schema still on zod, which cannot hold one
// directly. It decodes as the Effect schema does, so unknown keys are
// dropped and defaults filled the same way. This file goes with the
// last zod schema.
function toZod<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
): z.ZodType<S["Type"], S["Encoded"]> {
  return z.custom<S["Encoded"]>().transform((value, ctx) => {
    const result = safeDecode(schema, value);
    if (result.success) return result.data;
    ctx.addIssue({ code: "custom", message: result.error.message });
    return z.NEVER;
  });
}

export const DeviceIdZod = toZod(DeviceIdSchema);
export const CommitHashZod = toZod(CommitHashSchema);
export const GitRefNameZod = toZod(GitRefNameSchema);
export const HexId32Zod = toZod(HexId32Schema);
export const MirrorIgnoreModeZod = toZod(MirrorIgnoreModeSchema);
export const MirrorIgnoresZod = toZod(MirrorIgnoresSchema);
export const ProjectZod = toZod(ProjectSchema);
export const SyncCloneIntoZod = toZod(SyncCloneIntoSchema);
export const SyncLandingRefZod = toZod(SyncLandingRefSchema);
export const SyncPullFilesZod = toZod(SyncPullFilesSchema);
export const WorktreeIdZod = toZod(WorktreeIdSchema);
export const WorktreeZod = toZod(WorktreeSchema);
