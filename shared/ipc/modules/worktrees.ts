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
    { tracksProjectUsage: true },
  ),
  convertExternal: invoke(
    "worktrees:convertExternal",
    ConvertExternalWorktreePayloadSchema,
    CreateWorktreeResultSchema,
    { tracksProjectUsage: true },
  ),
  relocate: invoke(
    "worktrees:relocate",
    RelocateWorktreePayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  delete: invoke(
    "worktrees:delete",
    DeleteWorktreePayloadSchema,
    DeleteWorktreeResultSchema,
    { tracksProjectUsage: true },
  ),
  renameBranch: invoke(
    "worktrees:renameBranch",
    RenameBranchPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  setShelved: invoke(
    "worktrees:setShelved",
    SetShelvedPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  checkoutBranch: invoke(
    "worktrees:checkoutBranch",
    CheckoutBranchPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
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
  push: invoke("worktrees:push", SyncWorktreePayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
  }),
  pull: invoke("worktrees:pull", SyncWorktreePayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
  }),
  pushForce: invoke(
    "worktrees:pushForce",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  overwrite: invoke(
    "worktrees:overwrite",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  publish: invoke(
    "worktrees:publish",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
    {
      tracksProjectUsage: true,
    },
  ),
  pullAndPush: invoke(
    "worktrees:pullAndPush",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  syncWithPrimary: invoke(
    "worktrees:syncWithPrimary",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  switchToPrimary: invoke(
    "worktrees:switchToPrimary",
    SyncWorktreePayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
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
