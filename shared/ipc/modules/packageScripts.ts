import { Schema } from "effect";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  PackageScriptSortModeSchema,
  PackageScriptsResultSchema,
  ProjectScopedPayloadSchema,
  RunPackageScriptPayloadSchema,
  SetPackageScriptSortPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

export const packageScriptsContract = defineContract("host", {
  list: invoke(
    "packageScripts:list",
    WorktreeScopedPayloadSchema,
    Schema.NullOr(PackageScriptsResultSchema),
    { remote: true, mutating: false },
  ),
  run: invoke(
    "packageScripts:run",
    RunPackageScriptPayloadSchema,
    Schema.Struct({ runId: Schema.String }),
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  getSort: invoke(
    "packageScripts:getSort",
    ProjectScopedPayloadSchema,
    PackageScriptSortModeSchema,
    { remote: true, mutating: false },
  ),
  setSort: invoke(
    "packageScripts:setSort",
    SetPackageScriptSortPayloadSchema,
    Schema.Undefined,
    { remote: true, mutating: true },
  ),
});
