import { z } from "zod";
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
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

export const packageScriptsContract = defineContract("host", {
  list: invoke(
    "packageScripts:list",
    WorktreeScopedPayloadSchema,
    PackageScriptsResultSchema.nullable(),
    { remote: true, gated: false },
  ),
  run: invoke(
    "packageScripts:run",
    RunPackageScriptPayloadSchema,
    z.object({ runId: z.string() }),
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
    z.void(),
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
    z.void(),
    { remote: true, gated: true },
  ),
  setLaunchRow: invoke(
    "packageScripts:setLaunchRow",
    SetPackageScriptLaunchRowPayloadSchema,
    z.void(),
    { remote: true, gated: true },
  ),
});
