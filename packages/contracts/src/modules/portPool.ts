import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { VoidSchema, WorktreeScopedPayloadSchema } from "../schemas/index.ts";

export const portPoolContract = defineContract(
  "portPool",
  "host",
  invoke("isActive", WorktreeScopedPayloadSchema, Schema.Boolean, {
    remote: true,
    gated: false,
  }),
  invoke("isInstalled", VoidSchema, Schema.Boolean, {
    remote: true,
    gated: false,
  }),
);
