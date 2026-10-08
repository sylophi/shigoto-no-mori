import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  ProjectScopedPayloadSchema,
  StoredShigomoriConfigSchema,
  VoidSchema,
  WriteShigomoriPayloadSchema,
} from "../schemas/index.ts";

export const shigomoriContract = defineContract(
  "shigomori",
  "host",
  invoke(
    "read",
    ProjectScopedPayloadSchema,
    Schema.NullOr(StoredShigomoriConfigSchema),
    { remote: true, gated: false },
  ),
  invoke("write", WriteShigomoriPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "runCommands",
  }),
);
