import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  ApplyStashPayloadSchema,
  BranchHistorySchema,
  ChangedFileSchema,
  CheckoutBranchPayloadSchema,
  CommitChangesPayloadSchema,
  CommitChangesResultSchema,
  CommitDiffPayloadSchema,
  CommitMessageSchema,
  CommitSummarySchema,
  ConvertExternalPayloadSchema,
  CreateWorktreePayloadSchema,
  CreateWorktreeResultSchema,
  DeleteStackPayloadSchema,
  DeleteStackResultSchema,
  DeleteWorktreePayloadSchema,
  DeleteWorktreeResultSchema,
  DiscardChangesPayloadSchema,
  DiscardHunksPayloadSchema,
  DiscardChangesResultSchema,
  DropStashPayloadSchema,
  FileDiffPayloadSchema,
  FileHunksPayloadSchema,
  GitOperationStateSchema,
  HunkStatesSchema,
  ListCommitsPayloadSchema,
  ProjectScopedPayloadSchema,
  RelocateWorktreePayloadSchema,
  RenameBranchPayloadSchema,
  ResolveConflictPayloadSchema,
  ResetSoftPayloadSchema,
  ResetSoftResultSchema,
  ReadWorktreeFilePayloadSchema,
  RestoreDiscardPayloadSchema,
  RestoreStashPayloadSchema,
  RewordCommitPayloadSchema,
  SetAutoPullPayloadSchema,
  SetHunksStagedPayloadSchema,
  SetAgentWorkingPayloadSchema,
  SetShelvedPayloadSchema,
  SetStagedPayloadSchema,
  SquashCommitPayloadSchema,
  StashChangesPayloadSchema,
  StashEntrySchema,
  WorktreeCarryOverCompleteSchema,
  WorktreeFileSchema,
  WorktreeLifecyclePhaseSchema,
  WorktreeRemovalSchema,
  WorktreeSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

// Every worktree-scoped git mutation shares this contract; naming it
// once means a new one can't silently miss tracksProjectUsage.
const worktreeMutation = <Ch extends string>(channel: Ch) =>
  invoke(channel, WorktreeScopedPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
  });

export const worktreesContract = defineContract("host", {
  list: invoke(
    "worktrees:list",
    ProjectScopedPayloadSchema,
    z.array(WorktreeSchema),
    { remote: true, gated: false },
  ),
  create: invoke(
    "worktrees:create",
    CreateWorktreePayloadSchema,
    CreateWorktreeResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  convertExternal: invoke(
    "worktrees:convertExternal",
    ConvertExternalPayloadSchema,
    CreateWorktreeResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  relocate: invoke(
    "worktrees:relocate",
    RelocateWorktreePayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // A mirror's stop removes the copy on the copy's device, so a mirror
  // asked for there may delete that one worktree (invitable).
  delete: invoke(
    "worktrees:delete",
    DeleteWorktreePayloadSchema,
    DeleteWorktreeResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true, invitable: "copy" },
  ),
  // The merged layers of a stack, removed together (sm land --stack).
  deleteStack: invoke(
    "worktrees:deleteStack",
    DeleteStackPayloadSchema,
    DeleteStackResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  renameBranch: invoke(
    "worktrees:renameBranch",
    RenameBranchPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  setShelved: invoke(
    "worktrees:setShelved",
    SetShelvedPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // A flag flip. The renderer follows a mark with git:refreshProject,
  // whose auto-pull pass answers the "Pull N commits" pill right away.
  setAutoPull: invoke(
    "worktrees:setAutoPull",
    SetAutoPullPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  setAgentWorking: invoke(
    "worktrees:setAgentWorking",
    SetAgentWorkingPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  checkoutBranch: invoke(
    "worktrees:checkoutBranch",
    CheckoutBranchPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // One file's working-tree diff, which is what the changes page reads
  // as you pick files. Per file rather than per worktree so the pane
  // can't be describing a different moment than the list beside it.
  fileDiff: invoke("worktrees:fileDiff", FileDiffPayloadSchema, z.string(), {
    remote: true,
    gated: false,
  }),
  // One file of the worktree, whole, for the files page. A read, but
  // it discloses any file in the checkout (an ignored .env included),
  // so it rides the command grant like the folder listing the page
  // browses with (sync:worktreeFolder).
  readFile: invoke(
    "worktrees:readFile",
    ReadWorktreeFilePayloadSchema,
    WorktreeFileSchema,
    { remote: true, gated: true, movesHostState: false },
  ),
  // The changes page's list: every changed file, its index state and
  // its counts. The one read the page needs to draw the rail, and the
  // one a tick refetches.
  changeStatus: invoke(
    "worktrees:changeStatus",
    WorktreeScopedPayloadSchema,
    z.array(ChangedFileSchema),
    { remote: true, gated: false },
  ),
  // Answers with the fresh status so a tick settles in one round trip.
  setStaged: invoke(
    "worktrees:setStaged",
    SetStagedPayloadSchema,
    z.array(ChangedFileSchema),
    { remote: true, gated: true },
  ),
  // One modified file's hunks (host/lib/git/hunks.ts): which the next
  // commit takes, ticking them, and throwing them away.
  fileHunks: invoke(
    "worktrees:fileHunks",
    FileHunksPayloadSchema,
    HunkStatesSchema,
    { remote: true, gated: false },
  ),
  setHunksStaged: invoke(
    "worktrees:setHunksStaged",
    SetHunksStagedPayloadSchema,
    z.array(ChangedFileSchema),
    { remote: true, gated: true },
  ),
  discardHunks: invoke(
    "worktrees:discardHunks",
    DiscardHunksPayloadSchema,
    DiscardChangesResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  commit: invoke(
    "worktrees:commit",
    CommitChangesPayloadSchema,
    CommitChangesResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  discardChanges: invoke(
    "worktrees:discardChanges",
    DiscardChangesPayloadSchema,
    DiscardChangesResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  restoreDiscard: invoke(
    "worktrees:restoreDiscard",
    RestoreDiscardPayloadSchema,
    WorktreeSchema,
    { remote: true, gated: true },
  ),
  commitMessage: invoke(
    "worktrees:commitMessage",
    CommitDiffPayloadSchema,
    CommitMessageSchema,
    { remote: true, gated: false },
  ),
  resetSoft: invoke(
    "worktrees:resetSoft",
    ResetSoftPayloadSchema,
    ResetSoftResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  commitDiff: invoke(
    "worktrees:commitDiff",
    CommitDiffPayloadSchema,
    z.string(),
    {
      remote: true,
      gated: false,
    },
  ),
  listCommits: invoke(
    "worktrees:listCommits",
    ListCommitsPayloadSchema,
    z.array(CommitSummarySchema),
    { remote: true, gated: false },
  ),
  // The Git timeline: the branch's own commits back to where it left
  // the primary branch, and its upstream.
  branchHistory: invoke(
    "worktrees:branchHistory",
    WorktreeScopedPayloadSchema,
    BranchHistorySchema,
    { remote: true, gated: false },
  ),
  // What the branch changes against the primary branch, as a pull
  // request would show it, pull request or not.
  branchDiff: invoke(
    "worktrees:branchDiff",
    WorktreeScopedPayloadSchema,
    z.string(),
    {
      remote: true,
      gated: false,
    },
  ),
  // The commit menu's history moves (host/lib/git/history.ts). A
  // cherry-pick's worktree is the one the commit lands on.
  revertCommit: invoke(
    "worktrees:revertCommit",
    CommitDiffPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  cherryPick: invoke(
    "worktrees:cherryPick",
    CommitDiffPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  rewordCommit: invoke(
    "worktrees:rewordCommit",
    RewordCommitPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  squashCommit: invoke(
    "worktrees:squashCommit",
    SquashCommitPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // The stashes made on the worktree's branch (host/lib/git/stash.ts).
  stashes: invoke(
    "worktrees:stashes",
    WorktreeScopedPayloadSchema,
    z.array(StashEntrySchema),
    { remote: true, gated: false },
  ),
  // One stash's contents, as a patch.
  stashDiff: invoke("worktrees:stashDiff", DropStashPayloadSchema, z.string(), {
    remote: true,
    gated: false,
  }),
  stashChanges: invoke(
    "worktrees:stashChanges",
    StashChangesPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  applyStash: invoke(
    "worktrees:applyStash",
    ApplyStashPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  dropStash: invoke("worktrees:dropStash", DropStashPayloadSchema, z.void(), {
    remote: true,
    gated: true,
  }),
  // A drop's undo.
  restoreStash: invoke(
    "worktrees:restoreStash",
    RestoreStashPayloadSchema,
    z.void(),
    { remote: true, gated: true },
  ),
  // A merge, rebase, cherry-pick or revert stopped on conflicts
  // (host/lib/git/operation.ts), and the moves that see it through.
  operation: invoke(
    "worktrees:operation",
    WorktreeScopedPayloadSchema,
    GitOperationStateSchema,
    { remote: true, gated: false },
  ),
  resolveConflict: invoke(
    "worktrees:resolveConflict",
    ResolveConflictPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  continueOperation: worktreeMutation("worktrees:continueOperation"),
  abortOperation: worktreeMutation("worktrees:abortOperation"),
  // The way on from a sync from primary that conflicts: merge anyway
  // and stop on the conflicts.
  mergePrimary: worktreeMutation("worktrees:mergePrimary"),
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
