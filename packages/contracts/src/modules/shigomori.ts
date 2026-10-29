import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  ProjectScopedPayloadSchema,
  StoredShigomoriConfigSchema,
  VoidSchema,
  PatchShigomoriPayloadSchema,
  SyncProjectSettingsPayloadSchema,
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
  invoke("patch", PatchShigomoriPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "runCommands",
  }),
  // Switches the sync of the project's repo's settings across every
  // device holding it. Turned on, the others take this project's.
  invoke("syncSettings", SyncProjectSettingsPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "runCommands",
  }),
);
