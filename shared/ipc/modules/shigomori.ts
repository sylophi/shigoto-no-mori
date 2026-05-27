import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { invoke } from "@shared/ipc/contract";
import {
  ReadShigomoriPayloadSchema,
  ReadWorktreeDataPayloadSchema,
  ShigomoriConfigSchema,
  ShigomoriWorktreeDataSchema,
  WriteShigomoriPayloadSchema,
  WriteWorktreeDataPayloadSchema,
} from "@shared/schemas";
import type { ShigomoriConfig, ShigomoriWorktreeData } from "@shared/schemas";

export const shigomoriContract = {
  read: invoke(
    "shigomori:read",
    ReadShigomoriPayloadSchema,
    ShigomoriConfigSchema.nullable(),
  ),
  write: invoke("shigomori:write", WriteShigomoriPayloadSchema, z.void()),
  worktreeDataRead: invoke(
    "worktreeData:read",
    ReadWorktreeDataPayloadSchema,
    ShigomoriWorktreeDataSchema.nullable(),
  ),
  worktreeDataWrite: invoke(
    "worktreeData:write",
    WriteWorktreeDataPayloadSchema,
    z.void(),
  ),
} as const;

export type ShigomoriContract = typeof shigomoriContract;

const client = buildClient(shigomoriContract);

export const shigomori = {
  read: (projectId: string) => client.read({ projectId }),
  write: (projectId: string, config: ShigomoriConfig) =>
    client.write({ projectId, config }),
} as const;

export const worktreeData = {
  read: (projectId: string, worktreeId: string) =>
    client.worktreeDataRead({ projectId, worktreeId }),
  write: (projectId: string, worktreeId: string, data: ShigomoriWorktreeData) =>
    client.worktreeDataWrite({ projectId, worktreeId, data }),
} as const;
