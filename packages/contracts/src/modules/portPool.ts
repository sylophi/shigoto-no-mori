import * as Schema from "effect/Schema";
import { defineContract, invoke, ungated } from "../contract.ts";
import { VoidSchema, WorktreeScopedPayloadSchema } from "../schemas/index.ts";

export const portPoolContract = defineContract(
  "portPool",
  { scope: "host", version: 1 },
  invoke("isActive", WorktreeScopedPayloadSchema, Schema.Boolean, ungated),
  invoke("isInstalled", VoidSchema, Schema.Boolean, ungated),
);
