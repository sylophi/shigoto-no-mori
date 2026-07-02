import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  PackageScriptSortModeSchema,
  PackageScriptsResultSchema,
  ProjectScopedPayloadSchema,
  RunPackageScriptPayloadSchema,
  SetPackageScriptSortPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

export const packageScriptsContract = {
  list: invoke(
    "packageScripts:list",
    WorktreeScopedPayloadSchema,
    PackageScriptsResultSchema.nullable(),
  ),
  run: invoke(
    "packageScripts:run",
    RunPackageScriptPayloadSchema,
    z.object({ runId: z.string() }),
    { tracksProjectUsage: true },
  ),
  getSort: invoke(
    "packageScripts:getSort",
    ProjectScopedPayloadSchema,
    PackageScriptSortModeSchema,
  ),
  setSort: invoke(
    "packageScripts:setSort",
    SetPackageScriptSortPayloadSchema,
    z.void(),
  ),
} as const;

export type PackageScriptsContract = typeof packageScriptsContract;
