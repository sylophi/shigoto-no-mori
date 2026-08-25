import { z } from "zod";
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
    ProjectScopedPayloadSchema,
    PackageScriptSortModeSchema,
    { remote: true, mutating: false },
  ),
  setSort: invoke(
    "packageScripts:setSort",
    SetPackageScriptSortPayloadSchema,
    z.void(),
    { remote: true, mutating: true },
  ),
});
