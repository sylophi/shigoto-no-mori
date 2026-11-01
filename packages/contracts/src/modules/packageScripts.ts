import * as Schema from "effect/Schema";
import { defineContract, invoke, gatedBy, ungated } from "../contract.ts";
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
    ungated,
  ),
  invoke(
    "run",
    RunPackageScriptPayloadSchema,
    Schema.Struct({ runId: Schema.String }),
    { ...gatedBy("runCommands"), tracksProjectUsage: true },
  ),
  invoke(
    "getSort",
    GetPackageScriptSortPayloadSchema,
    PackageScriptSortModeSchema,
    ungated,
  ),
  invoke(
    "setSort",
    SetPackageScriptSortPayloadSchema,
    VoidSchema,
    gatedBy("changeApp"),
  ),
  invoke(
    "getOrder",
    ProjectScopedPayloadSchema,
    PackageScriptOrderSchema,
    ungated,
  ),
  invoke(
    "setOrder",
    SetPackageScriptOrderPayloadSchema,
    VoidSchema,
    gatedBy("changeApp"),
  ),
  invoke(
    "setLaunchRow",
    SetPackageScriptLaunchRowPayloadSchema,
    VoidSchema,
    gatedBy("changeApp"),
  ),
);
