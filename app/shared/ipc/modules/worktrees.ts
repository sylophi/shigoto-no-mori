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
  MergeBranchPayloadSchema,
  MergeBranchResultSchema,
  MergePreviewPayloadSchema,
  MergePreviewSchema,
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
  SetShelvedPayloadSchema,
  SetStagedPayloadSchema,
  SquashCommitPayloadSchema,
  StashChangesPayloadSchema,
  StashEntrySchema,
  AgentSessionPayloadSchema,
  WorktreeCarryOverCompleteSchema,
  WorktreeFileSchema,
  WorktreeLifecyclePhaseSchema,
  WorktreeRemovalSchema,
  WorktreeSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

// Every worktree-scoped git mutation shares this contract; naming it
// once means a new one can't silently miss tracksProjectUsage.
const worktreeMutationOf = <Ch extends string, P extends z.ZodType>(
  channel: Ch,
  payload: P,
) =>
  invoke(channel, payload, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
  });
const worktreeMutation = <Ch extends string>(channel: Ch) =>
  worktreeMutationOf(channel, WorktreeScopedPayloadSchema);

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
  // Every agent session bound to the worktree goes idle, for a turn
  // whose end no hook reported.
  idleAgents: invoke(
    "worktrees:idleAgents",
    WorktreeScopedPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // One agent session stops being bound to the worktree.
  unbindAgent: invoke(
    "worktrees:unbindAgent",
    AgentSessionPayloadSchema,
    WorktreeSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // One agent session picks up again in its harness's CLI, in a
  // terminal on this machine, so like a launch it isn't served to
  // other devices.
  resumeAgent: invoke(
    "worktrees:resumeAgent",
    AgentSessionPayloadSchema,
    z.void(),
    { tracksProjectUsage: true, remote: false },
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
  revertCommit: worktreeMutationOf(
    "worktrees:revertCommit",
    CommitDiffPayloadSchema,
  ),
  cherryPick: worktreeMutationOf(
    "worktrees:cherryPick",
    CommitDiffPayloadSchema,
  ),
  rewordCommit: worktreeMutationOf(
    "worktrees:rewordCommit",
    RewordCommitPayloadSchema,
  ),
  squashCommit: worktreeMutationOf(
    "worktrees:squashCommit",
    SquashCommitPayloadSchema,
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
  stashChanges: worktreeMutationOf(
    "worktrees:stashChanges",
    StashChangesPayloadSchema,
  ),
  applyStash: worktreeMutationOf(
    "worktrees:applyStash",
    ApplyStashPayloadSchema,
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
  resolveConflict: worktreeMutationOf(
    "worktrees:resolveConflict",
    ResolveConflictPayloadSchema,
  ),
  // Another branch brought into the worktree's (host/lib/git/merge.ts):
  // first how the two stand, then the move.
  mergePreview: invoke(
    "worktrees:mergePreview",
    MergePreviewPayloadSchema,
    MergePreviewSchema,
    { remote: true, gated: false },
  ),
  mergeBranch: invoke(
    "worktrees:mergeBranch",
    MergeBranchPayloadSchema,
    MergeBranchResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  continueOperation: worktreeMutation("worktrees:continueOperation"),
  abortOperation: worktreeMutation("worktrees:abortOperation"),
  // The way on from a sync from primary that conflicts: merge anyway
  // and stop on the conflicts.
  mergePrimary: invoke(
    "worktrees:mergePrimary",
    WorktreeScopedPayloadSchema,
    MergeBranchResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // The way on from a split with the upstream that conflicts: merge it
  // and stop on the conflicts.
  mergeUpstream: invoke(
    "worktrees:mergeUpstream",
    WorktreeScopedPayloadSchema,
    MergeBranchResultSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
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
