import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  GetPackageScriptSortPayloadSchema,
  PackageScriptOrderSchema,
  PackageScriptSortModeSchema,
  PackageScriptsResultSchema,
  ProjectScopedPayloadSchema,
  RunPackageScriptPayloadSchema,
  SetPackageScriptOrderPayloadSchema,
  SetPackageScriptSortPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

export const packageScriptsContract = defineContract("host", {
  list: invoke(
    "packageScripts:list",
    WorktreeScopedPayloadSchema,
    PackageScriptsResultSchema.nullable(),
    { remote: true, mutating: false },
  ),
  run: invoke(
    "packageScripts:run",
    RunPackageScriptPayloadSchema,
    z.object({ runId: z.string() }),
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  getSort: invoke(
    "packageScripts:getSort",
    GetPackageScriptSortPayloadSchema,
    PackageScriptSortModeSchema,
    { remote: true, mutating: false },
  ),
  setSort: invoke(
    "packageScripts:setSort",
    SetPackageScriptSortPayloadSchema,
    z.void(),
    { remote: true, mutating: true },
  ),
  getOrder: invoke(
    "packageScripts:getOrder",
    ProjectScopedPayloadSchema,
    PackageScriptOrderSchema,
    { remote: true, mutating: false },
  ),
  setOrder: invoke(
    "packageScripts:setOrder",
    SetPackageScriptOrderPayloadSchema,
    z.void(),
    { remote: true, mutating: true },
  ),
});
