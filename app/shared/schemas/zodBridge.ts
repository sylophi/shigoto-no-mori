import type * as Schema from "effect/Schema";
import { z } from "zod";
import { safeDecode } from "@shared/ipc/schema";
import {
  CloneFolderNameSchema,
  GitRefNameSchema,
  ProjectSchema,
  ProjectSortModeSchema,
  SidebarViewSchema,
} from "./project";

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

export const CloneFolderNameZod = toZod(CloneFolderNameSchema);
export const GitRefNameZod = toZod(GitRefNameSchema);
export const ProjectZod = toZod(ProjectSchema);
export const ProjectSortModeZod = toZod(ProjectSortModeSchema);
export const SidebarViewZod = toZod(SidebarViewSchema);
