import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  GetPackageScriptSortPayloadSchema,
  ListPackageScriptsPayloadSchema,
  PackageScriptSortModeSchema,
  PackageScriptsResultSchema,
  RunPackageScriptPayloadSchema,
  SetPackageScriptSortPayloadSchema,
} from "@shared/schemas";

export const packageScriptsContract = {
  list: invoke(
    "packageScripts:list",
    ListPackageScriptsPayloadSchema,
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
    GetPackageScriptSortPayloadSchema,
    PackageScriptSortModeSchema,
  ),
  setSort: invoke(
    "packageScripts:setSort",
    SetPackageScriptSortPayloadSchema,
    z.void(),
  ),
} as const;

export type PackageScriptsContract = typeof packageScriptsContract;
