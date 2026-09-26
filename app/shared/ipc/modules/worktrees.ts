import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
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
  FileDiffPayloadSchema,
  ListCommitsPayloadSchema,
  ProjectScopedPayloadSchema,
  RelocateWorktreePayloadSchema,
  RenameBranchPayloadSchema,
  ResetSoftPayloadSchema,
  ResetSoftResultSchema,
  ReadWorktreeFilePayloadSchema,
  RestoreDiscardPayloadSchema,
  SetAutoPullPayloadSchema,
  SetShelvedPayloadSchema,
  SetStagedPayloadSchema,
  WorktreeCarryOverCompleteSchema,
  WorktreeFileSchema,
  WorktreeLifecyclePhaseSchema,
  WorktreeRemovalSchema,
  WorktreeSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

// Every worktree-scoped git mutation shares this contract; naming it
// once means a new one can't silently miss tracksProjectUsage.
const worktreeMutation = (channel: string) =>
  invoke(channel, WorktreeScopedPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    mutating: true,
  });

export const worktreesContract = defineContract("host", {
  list: invoke(
    "worktrees:list",
    ProjectScopedPayloadSchema,
    z.array(WorktreeSchema),
    { remote: true, mutating: false },
  ),
  create: invoke(
    "worktrees:create",
    CreateWorktreePayloadSchema,
    CreateWorktreeResultSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  convertExternal: invoke(
    "worktrees:convertExternal",
    WorktreeScopedPayloadSchema,
    CreateWorktreeResultSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  relocate: invoke(
    "worktrees:relocate",
    RelocateWorktreePayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  delete: invoke(
    "worktrees:delete",
    DeleteWorktreePayloadSchema,
    DeleteWorktreeResultSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  renameBranch: invoke(
    "worktrees:renameBranch",
    RenameBranchPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  setShelved: invoke(
    "worktrees:setShelved",
    SetShelvedPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  // A flag flip. The renderer follows a mark with git:refreshProject,
  // whose auto-pull pass answers the "Pull N commits" pill right away.
  setAutoPull: invoke(
    "worktrees:setAutoPull",
    SetAutoPullPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  checkoutBranch: invoke(
    "worktrees:checkoutBranch",
    CheckoutBranchPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  // One file's working-tree diff, which is what the changes page reads
  // as you pick files. Per file rather than per worktree so the pane
  // can't be describing a different moment than the list beside it.
  fileDiff: invoke("worktrees:fileDiff", FileDiffPayloadSchema, z.string(), {
    remote: true,
    mutating: false,
  }),
  // One file of the worktree, whole, for the files page. A read, but
  // it discloses any file in the checkout (an ignored .env included),
  // so it rides the command grant like the folder listing the page
  // browses with (sync:worktreeFolder).
  readFile: invoke(
    "worktrees:readFile",
    ReadWorktreeFilePayloadSchema,
    WorktreeFileSchema,
    { remote: true, mutating: true, movesHostState: false },
  ),
  // The changes page's list: every changed file, its index state and
  // its counts. The one read the page needs to draw the rail, and the
  // one a tick refetches.
  changeStatus: invoke(
    "worktrees:changeStatus",
    WorktreeScopedPayloadSchema,
    z.array(ChangedFileSchema),
    { remote: true, mutating: false },
  ),
  // Answers with the fresh status so a tick settles in one round trip.
  setStaged: invoke(
    "worktrees:setStaged",
    SetStagedPayloadSchema,
    z.array(ChangedFileSchema),
    { remote: true, mutating: true },
  ),
  commit: invoke(
    "worktrees:commit",
    CommitChangesPayloadSchema,
    CommitChangesResultSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  discardChanges: invoke(
    "worktrees:discardChanges",
    DiscardChangesPayloadSchema,
    DiscardChangesResultSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  restoreDiscard: invoke(
    "worktrees:restoreDiscard",
    RestoreDiscardPayloadSchema,
    WorktreeSchema,
    { remote: true, mutating: true },
  ),
  commitMessage: invoke(
    "worktrees:commitMessage",
    CommitDiffPayloadSchema,
    CommitMessageSchema,
    { remote: true, mutating: false },
  ),
  resetSoft: invoke(
    "worktrees:resetSoft",
    ResetSoftPayloadSchema,
    ResetSoftResultSchema,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
  commitDiff: invoke(
    "worktrees:commitDiff",
    CommitDiffPayloadSchema,
    z.string(),
    {
      remote: true,
      mutating: false,
    },
  ),
  listCommits: invoke(
    "worktrees:listCommits",
    ListCommitsPayloadSchema,
    z.array(CommitSummarySchema),
    { remote: true, mutating: false },
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
    { remote: true },
  ),
  carryOverComplete: broadcast(
    "worktrees:carryOverComplete",
    WorktreeCarryOverCompleteSchema,
    { remote: true },
  ),
  removal: broadcast("worktrees:removal", WorktreeRemovalSchema, {
    remote: true,
  }),
});
