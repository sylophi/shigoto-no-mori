import * as Schema from "effect/Schema";
import { defineContract, invoke } from "@shared/ipc/contract";
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
} from "@shared/schemas";

export const packageScriptsContract = defineContract("host", {
  list: invoke(
    "packageScripts:list",
    WorktreeScopedPayloadSchema,
    Schema.NullOr(PackageScriptsResultSchema),
    { remote: true, gated: false },
  ),
  run: invoke(
    "packageScripts:run",
    RunPackageScriptPayloadSchema,
    Schema.Struct({ runId: Schema.String }),
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  getSort: invoke(
    "packageScripts:getSort",
    GetPackageScriptSortPayloadSchema,
    PackageScriptSortModeSchema,
    { remote: true, gated: false },
  ),
  setSort: invoke(
    "packageScripts:setSort",
    SetPackageScriptSortPayloadSchema,
    VoidSchema,
    { remote: true, gated: true },
  ),
  getOrder: invoke(
    "packageScripts:getOrder",
    ProjectScopedPayloadSchema,
    PackageScriptOrderSchema,
    { remote: true, gated: false },
  ),
  setOrder: invoke(
    "packageScripts:setOrder",
    SetPackageScriptOrderPayloadSchema,
    VoidSchema,
    { remote: true, gated: true },
  ),
  setLaunchRow: invoke(
    "packageScripts:setLaunchRow",
    SetPackageScriptLaunchRowPayloadSchema,
    VoidSchema,
    { remote: true, gated: true },
  ),
});
