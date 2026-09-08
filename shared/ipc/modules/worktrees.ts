import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  ChangedFileSchema,
  CheckoutBranchPayloadSchema,
  CommitChangesPayloadSchema,
  CommitChangesResultSchema,
  CommitDiffPayloadSchema,
  CommitMessageSchema,
  CommitSummarySchema,
  CreateWorktreePayloadSchema,
  CreateWorktreeResultSchema,
  DeleteWorktreePayloadSchema,
  DeleteWorktreeResultSchema,
  DiscardChangesPayloadSchema,
  DiscardChangesResultSchema,
  ListCommitsPayloadSchema,
  ProjectScopedPayloadSchema,
  RelocateWorktreePayloadSchema,
  RenameBranchPayloadSchema,
  ResetSoftPayloadSchema,
  ResetSoftResultSchema,
  RestoreDiscardPayloadSchema,
  SetShelvedPayloadSchema,
  SetStagedPayloadSchema,
  WorktreeCarryOverCompleteSchema,
  WorktreeLifecyclePhaseSchema,
  WorktreeSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

// Every worktree-scoped git mutation shares this contract; naming it
// once means a new one can't silently miss tracksProjectUsage.
const worktreeMutation = (channel: string) =>
  invoke(channel, WorktreeScopedPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
  });

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
  // The changes page: what each changed file's index state is, plus the
  // mutations that tick, commit and discard. `diff` above stays the
  // patch source. This is the cheap call that refetches after a toggle.
  changeStatus: invoke(
    "worktrees:changeStatus",
    WorktreeScopedPayloadSchema,
    z.array(ChangedFileSchema),
  ),
  // Answers with the fresh status so a tick settles in one round trip.
  setStaged: invoke(
    "worktrees:setStaged",
    SetStagedPayloadSchema,
    z.array(ChangedFileSchema),
  ),
  commit: invoke(
    "worktrees:commit",
    CommitChangesPayloadSchema,
    CommitChangesResultSchema,
    { tracksProjectUsage: true },
  ),
  discardChanges: invoke(
    "worktrees:discardChanges",
    DiscardChangesPayloadSchema,
    DiscardChangesResultSchema,
    { tracksProjectUsage: true },
  ),
  restoreDiscard: invoke(
    "worktrees:restoreDiscard",
    RestoreDiscardPayloadSchema,
    WorktreeSchema,
  ),
  commitMessage: invoke(
    "worktrees:commitMessage",
    CommitDiffPayloadSchema,
    CommitMessageSchema,
  ),
  resetSoft: invoke(
    "worktrees:resetSoft",
    ResetSoftPayloadSchema,
    ResetSoftResultSchema,
    { tracksProjectUsage: true },
  ),
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
  push: worktreeMutation("worktrees:push"),
  pull: worktreeMutation("worktrees:pull"),
  pushForce: worktreeMutation("worktrees:pushForce"),
  overwrite: worktreeMutation("worktrees:overwrite"),
  publish: worktreeMutation("worktrees:publish"),
  pullAndPush: worktreeMutation("worktrees:pullAndPush"),
  syncWithPrimary: worktreeMutation("worktrees:syncWithPrimary"),
  switchToPrimaryAndDeleteBranch: worktreeMutation(
    "worktrees:switchToPrimaryAndDeleteBranch",
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
