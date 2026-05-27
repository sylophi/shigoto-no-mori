import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  CheckoutBranchPayloadSchema,
  CommitDiffPayloadSchema,
  CommitSummarySchema,
  ConvertExternalWorktreePayloadSchema,
  CreateWorktreePayloadSchema,
  CreateWorktreeResultSchema,
  DeleteWorktreePayloadSchema,
  DeleteWorktreeResultSchema,
  ListCommitsPayloadSchema,
  ListWorktreesPayloadSchema,
  RelocateWorktreePayloadSchema,
  RenameBranchPayloadSchema,
  SetShelvedPayloadSchema,
  SyncWorktreePayloadSchema,
  WorktreeCarryOverCompleteSchema,
  WorktreeDiffPayloadSchema,
  WorktreeLifecyclePhaseSchema,
  WorktreeSchema,
} from "@shared/schemas";

export const worktreesContract = {
  list: invoke(
    "worktrees:list",
    ListWorktreesPayloadSchema,
    z.array(WorktreeSchema),
  ),
  create: invoke(
    "worktrees:create",
    CreateWorktreePayloadSchema,
    CreateWorktreeResultSchema,
  ),
  convertExternal: invoke(
    "worktrees:convertExternal",
    ConvertExternalWorktreePayloadSchema,
    CreateWorktreeResultSchema,
  ),
  relocate: invoke(
    "worktrees:relocate",
    RelocateWorktreePayloadSchema,
    WorktreeSchema,
  ),
  delete: invoke(
    "worktrees:delete",
    DeleteWorktreePayloadSchema,
    DeleteWorktreeResultSchema,
  ),
  renameBranch: invoke(
    "worktrees:renameBranch",
    RenameBranchPayloadSchema,
    WorktreeSchema,
  ),
  setShelved: invoke(
    "worktrees:setShelved",
    SetShelvedPayloadSchema,
    WorktreeSchema,
  ),
  checkoutBranch: invoke(
    "worktrees:checkoutBranch",
    CheckoutBranchPayloadSchema,
    WorktreeSchema,
  ),
  diff: invoke("worktrees:diff", WorktreeDiffPayloadSchema, z.string()),
  commitDiff: invoke(
    "worktrees:commitDiff",
    CommitDiffPayloadSchema,
    z.string(),
  ),
  listCommits: invoke(
    "worktrees:listCommits",
    ListCommitsPayloadSchema,
    z.array(CommitSummarySchema),
  ),
  push: invoke("worktrees:push", SyncWorktreePayloadSchema, WorktreeSchema),
  pull: invoke("worktrees:pull", SyncWorktreePayloadSchema, WorktreeSchema),
  pushForce: invoke(
    "worktrees:pushForce",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
  ),
  overwrite: invoke(
    "worktrees:overwrite",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
  ),
  publish: invoke(
    "worktrees:publish",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
  ),
  pullAndPush: invoke(
    "worktrees:pullAndPush",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
  ),
  lifecyclePhase: broadcast(
    "worktrees:lifecyclePhase",
    WorktreeLifecyclePhaseSchema,
  ),
  carryOverComplete: broadcast(
    "worktrees:carryOverComplete",
    WorktreeCarryOverCompleteSchema,
  ),
} as const;

export type WorktreesContract = typeof worktreesContract;
