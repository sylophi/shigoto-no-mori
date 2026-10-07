import * as Schema from "effect/Schema";
import { defineContract, invoke } from "@shared/ipc/contract";
import { VoidSchema, WorktreeScopedPayloadSchema } from "@shared/schemas";

export const portPoolContract = defineContract("host", {
  isActive: invoke(
    "portPool:isActive",
    WorktreeScopedPayloadSchema,
    Schema.Boolean,
    { remote: true, gated: false },
  ),
  isInstalled: invoke("portPool:isInstalled", VoidSchema, Schema.Boolean, {
    remote: true,
    gated: false,
  }),
});
