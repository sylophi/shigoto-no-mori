import type * as Schema from "effect/Schema";
import { z } from "zod";
import { safeDecode } from "@shared/ipc/schema";

// An Effect schema inside a schema still on zod, which cannot hold one
// directly. It decodes as the Effect schema does, so unknown keys are
// dropped and defaults filled the same way. This file goes with the
// last zod schema.
export function toZod<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
): z.ZodType<S["Type"], S["Encoded"]> {
  return z.custom<S["Encoded"]>().transform((value, ctx) => {
    const result = safeDecode(schema, value);
    if (result.success) return result.data;
    ctx.addIssue({ code: "custom", message: result.error.message });
    return z.NEVER;
  });
}
