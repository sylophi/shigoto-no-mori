import * as Schema from "effect/Schema";
import { defineContract, invoke, gatedBy, ungated } from "../contract.ts";
import {
  ProjectScopedPayloadSchema,
  StoredShigomoriConfigSchema,
  VoidSchema,
  PatchShigomoriPayloadSchema,
  SyncProjectSettingsPayloadSchema,
} from "../schemas/index.ts";

export const shigomoriContract = defineContract(
  "shigomori",
  { scope: "host", version: 1 },
  invoke(
    "read",
    ProjectScopedPayloadSchema,
    Schema.NullOr(StoredShigomoriConfigSchema),
    ungated,
  ),
  invoke("patch", PatchShigomoriPayloadSchema, VoidSchema, {
    ...gatedBy("runCommands"),
    tracksProjectUsage: true,
  }),
  // Switches the sync of the project's repo's settings across every
  // device holding it. Turned on, the others take this project's.
  invoke(
    "syncSettings",
    SyncProjectSettingsPayloadSchema,
    VoidSchema,
    gatedBy("runCommands"),
  ),
);
