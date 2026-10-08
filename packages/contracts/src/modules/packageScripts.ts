import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  GetPackageScriptSortPayloadSchema,
  PackageScriptOrderSchema,
  PackageScriptSortModeSchema,
  PackageScriptsResultSchema,
  ProjectScopedPayloadSchema,
  RunPackageScriptPayloadSchema,
  SetPackageScriptLaunchRowPayloadSchema,
  SetPackageScriptOrderPayloadSchema,
  SetPackageScriptSortPayloadSchema,
  VoidSchema,
  WorktreeScopedPayloadSchema,
} from "../schemas/index.ts";

export const packageScriptsContract = defineContract(
  "packageScripts",
  "host",
  invoke(
    "list",
    WorktreeScopedPayloadSchema,
    Schema.NullOr(PackageScriptsResultSchema),
    { remote: true, gated: false },
  ),
  invoke(
    "run",
    RunPackageScriptPayloadSchema,
    Schema.Struct({ runId: Schema.String }),
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "runCommands",
    },
  ),
  invoke(
    "getSort",
    GetPackageScriptSortPayloadSchema,
    PackageScriptSortModeSchema,
    { remote: true, gated: false },
  ),
  invoke("setSort", SetPackageScriptSortPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  invoke("getOrder", ProjectScopedPayloadSchema, PackageScriptOrderSchema, {
    remote: true,
    gated: false,
  }),
  invoke("setOrder", SetPackageScriptOrderPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  invoke("setLaunchRow", SetPackageScriptLaunchRowPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
);
