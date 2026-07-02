import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  CheckoutBranchPayloadSchema,
  CommitDiffPayloadSchema,
  CommitSummarySchema,
  CreateWorktreePayloadSchema,
  CreateWorktreeResultSchema,
  DeleteWorktreePayloadSchema,
  DeleteWorktreeResultSchema,
  ListCommitsPayloadSchema,
  ProjectScopedPayloadSchema,
  RelocateWorktreePayloadSchema,
  RenameBranchPayloadSchema,
  SetShelvedPayloadSchema,
  WorktreeCarryOverCompleteSchema,
  WorktreeLifecyclePhaseSchema,
  WorktreeSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

export const worktreesContract = {
  list: invoke(
    "worktrees:list",
    ProjectScopedPayloadSchema,
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
    WorktreeScopedPayloadSchema,
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
  diff: invoke("worktrees:diff", WorktreeScopedPayloadSchema, z.string()),
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
  push: invoke("worktrees:push", WorktreeScopedPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
  }),
  pull: invoke("worktrees:pull", WorktreeScopedPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
  }),
  pushForce: invoke(
    "worktrees:pushForce",
    WorktreeScopedPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  overwrite: invoke(
    "worktrees:overwrite",
    WorktreeScopedPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  publish: invoke(
    "worktrees:publish",
    WorktreeScopedPayloadSchema,
    WorktreeSchema,
    {
      tracksProjectUsage: true,
    },
  ),
  pullAndPush: invoke(
    "worktrees:pullAndPush",
    WorktreeScopedPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  syncWithPrimary: invoke(
    "worktrees:syncWithPrimary",
    WorktreeScopedPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true },
  ),
  switchToPrimaryAndDeleteBranch: invoke(
    "worktrees:switchToPrimaryAndDeleteBranch",
    WorktreeScopedPayloadSchema,
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
