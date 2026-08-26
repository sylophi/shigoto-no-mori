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
    { remote: true },
  ),
  run: invoke(
    "packageScripts:run",
    RunPackageScriptPayloadSchema,
    z.object({ runId: z.string() }),
    { tracksProjectUsage: true, remote: true },
  ),
  getSort: invoke(
    "packageScripts:getSort",
    ProjectScopedPayloadSchema,
    PackageScriptSortModeSchema,
    { remote: true },
  ),
  setSort: invoke(
    "packageScripts:setSort",
    SetPackageScriptSortPayloadSchema,
    z.void(),
    { remote: false },
  ),
});
