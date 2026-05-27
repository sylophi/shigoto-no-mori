import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { invoke } from "@shared/ipc/contract";
import {
  GetPackageScriptSortPayloadSchema,
  ListPackageScriptsPayloadSchema,
  PackageScriptSortModeSchema,
  PackageScriptsResultSchema,
  RunPackageScriptPayloadSchema,
  SetPackageScriptSortPayloadSchema,
} from "@shared/schemas";
import type { PackageScriptSortMode } from "@shared/schemas";

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

const client = buildClient(packageScriptsContract);

export const packageScripts = {
  list: client.list,
  run: client.run,
  getSort: (projectId: string) => client.getSort({ projectId }),
  setSort: (projectId: string, mode: PackageScriptSortMode) =>
    client.setSort({ projectId, mode }),
} as const;
