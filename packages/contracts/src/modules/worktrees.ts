import * as Schema from "effect/Schema";
import type { ContractSchema } from "../codec.ts";
import { broadcast, defineContract, invoke, view } from "../contract.ts";
import {
  AgentSessionPayloadSchema,
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
  DiscardChangesResultSchema,
  DiscardHunksPayloadSchema,
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
  RenameWorktreePayloadSchema,
  RenameBranchPayloadSchema,
  ResetSoftPayloadSchema,
  ResetSoftResultSchema,
  ReadWorktreeFilePayloadSchema,
  RestoreDiscardPayloadSchema,
  RestoreStashPayloadSchema,
  ResolveConflictPayloadSchema,
  RewordCommitPayloadSchema,
  SetAutoPullPayloadSchema,
  SetHunksStagedPayloadSchema,
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
  VoidSchema,
} from "../schemas/index.ts";

// Every worktree-scoped git mutation shares this contract; naming it
// once means a new one can't silently miss tracksProjectUsage.
const worktreeMutationOf = <const Key extends string, P extends ContractSchema>(
  key: Key,
  payload: P,
) =>
  invoke(key, payload, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  });
const worktreeMutation = <const Key extends string>(key: Key) =>
  worktreeMutationOf(key, WorktreeScopedPayloadSchema);

export const worktreesContract = defineContract(
  "worktrees",
  "host",
  // A mirror into this device looks its copy up here (whether it is
  // gone), invited past the sharing switch.
  invoke("list", ProjectScopedPayloadSchema, Schema.Array(WorktreeSchema), {
    remote: true,
    gated: false,
    invitable: "project",
  }),
  view("watch", ProjectScopedPayloadSchema, Schema.Array(WorktreeSchema), {
    remote: true,
    gated: false,
  }),
  invoke("create", CreateWorktreePayloadSchema, CreateWorktreeResultSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke(
    "convertExternal",
    ConvertExternalPayloadSchema,
    CreateWorktreeResultSchema,
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "changeCode",
    },
  ),
  invoke("relocate", RelocateWorktreePayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke("rename", RenameWorktreePayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // A mirror's stop removes the copy on the copy's device, so a mirror
  // asked for there may delete that one worktree (invitable).
  invoke("delete", DeleteWorktreePayloadSchema, DeleteWorktreeResultSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
    invitable: "copy",
  }),
  // The merged layers of a stack, removed together (sm land --stack).
  invoke("deleteStack", DeleteStackPayloadSchema, DeleteStackResultSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke("renameBranch", RenameBranchPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke("setShelved", SetShelvedPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // A flag flip. The renderer follows a mark with git:refreshProject,
  // whose auto-pull pass answers the "Pull N commits" pill right away.
  invoke("setAutoPull", SetAutoPullPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // Every agent session bound to the worktree goes idle, for a turn
  // whose end no hook reported.
  worktreeMutation("idleAgents"),
  // One agent session stops being bound to the worktree.
  worktreeMutationOf("unbindAgent", AgentSessionPayloadSchema),
  // One agent session picks up again in its harness's CLI, in a
  // terminal on this machine, so like a launch it isn't served to
  // other devices.
  invoke("resumeAgent", AgentSessionPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: false,
  }),
  invoke("checkoutBranch", CheckoutBranchPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // One file's working-tree diff, which is what the changes page reads
  // as you pick files. Per file rather than per worktree so the pane
  // can't be describing a different moment than the list beside it.
  invoke("fileDiff", FileDiffPayloadSchema, Schema.String, {
    remote: true,
    gated: false,
  }),
  // One file of the worktree, whole, for the files page. A read, but
  // it discloses any file in the checkout (an ignored .env included),
  // so it rides the command grant like the folder listing the page
  // browses with (sync:worktreeFolder).
  invoke("readFile", ReadWorktreeFilePayloadSchema, WorktreeFileSchema, {
    remote: true,
    gated: true,
    grant: "browseFiles",
  }),
  // The changes page's list: every changed file, its index state and
  // its counts. The one read the page needs to draw the rail, and the
  // one a tick refetches.
  invoke(
    "changeStatus",
    WorktreeScopedPayloadSchema,
    Schema.Array(ChangedFileSchema),
    { remote: true, gated: false },
  ),
  view(
    "watchChangeStatus",
    WorktreeScopedPayloadSchema,
    Schema.Array(ChangedFileSchema),
    { remote: true, gated: false },
  ),
  // Answers with the fresh status so a tick settles in one round trip.
  invoke("setStaged", SetStagedPayloadSchema, Schema.Array(ChangedFileSchema), {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // One modified file's hunks (host/lib/git/hunks.ts): which the next
  // commit takes, ticking them, and throwing them away.
  invoke("fileHunks", FileHunksPayloadSchema, HunkStatesSchema, {
    remote: true,
    gated: false,
  }),
  invoke(
    "setHunksStaged",
    SetHunksStagedPayloadSchema,
    Schema.Array(ChangedFileSchema),
    { remote: true, gated: true, grant: "changeCode" },
  ),
  invoke(
    "discardHunks",
    DiscardHunksPayloadSchema,
    DiscardChangesResultSchema,
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "changeCode",
    },
  ),
  invoke("commit", CommitChangesPayloadSchema, CommitChangesResultSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke(
    "discardChanges",
    DiscardChangesPayloadSchema,
    DiscardChangesResultSchema,
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "changeCode",
    },
  ),
  invoke("restoreDiscard", RestoreDiscardPayloadSchema, WorktreeSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke("commitMessage", CommitDiffPayloadSchema, CommitMessageSchema, {
    remote: true,
    gated: false,
  }),
  invoke("resetSoft", ResetSoftPayloadSchema, ResetSoftResultSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke("commitDiff", CommitDiffPayloadSchema, Schema.String, {
    remote: true,
    gated: false,
  }),
  invoke(
    "listCommits",
    ListCommitsPayloadSchema,
    Schema.Array(CommitSummarySchema),
    { remote: true, gated: false },
  ),
  // The Git timeline: the branch's own commits back to where it left
  // the primary branch, and its upstream.
  invoke("branchHistory", WorktreeScopedPayloadSchema, BranchHistorySchema, {
    remote: true,
    gated: false,
  }),
  // What the branch changes against the primary branch, as a pull
  // request would show it, pull request or not.
  invoke("branchDiff", WorktreeScopedPayloadSchema, Schema.String, {
    remote: true,
    gated: false,
  }),
  // The commit menu's history moves (host/lib/git/history.ts). A
  // cherry-pick's worktree is the one the commit lands on.
  worktreeMutationOf("revertCommit", CommitDiffPayloadSchema),
  worktreeMutationOf("cherryPick", CommitDiffPayloadSchema),
  worktreeMutationOf("rewordCommit", RewordCommitPayloadSchema),
  worktreeMutationOf("squashCommit", SquashCommitPayloadSchema),
  // The stashes made on the worktree's branch (host/lib/git/stash.ts).
  invoke(
    "stashes",
    WorktreeScopedPayloadSchema,
    Schema.Array(StashEntrySchema),
    { remote: true, gated: false },
  ),
  // One stash's contents, as a patch.
  invoke("stashDiff", DropStashPayloadSchema, Schema.String, {
    remote: true,
    gated: false,
  }),
  worktreeMutationOf("stashChanges", StashChangesPayloadSchema),
  worktreeMutationOf("applyStash", ApplyStashPayloadSchema),
  invoke("dropStash", DropStashPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // A drop's undo.
  invoke("restoreStash", RestoreStashPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // A merge, rebase, cherry-pick or revert stopped on conflicts
  // (host/lib/git/operation.ts), and the moves that see it through.
  invoke("operation", WorktreeScopedPayloadSchema, GitOperationStateSchema, {
    remote: true,
    gated: false,
  }),
  worktreeMutationOf("resolveConflict", ResolveConflictPayloadSchema),
  // Another branch brought into the worktree's (host/lib/git/merge.ts):
  // first how the two stand, then the move.
  invoke("mergePreview", MergePreviewPayloadSchema, MergePreviewSchema, {
    remote: true,
    gated: false,
  }),
  invoke("mergeBranch", MergeBranchPayloadSchema, MergeBranchResultSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  worktreeMutation("continueOperation"),
  worktreeMutation("abortOperation"),
  // The way on from a sync from primary that conflicts: merge anyway
  // and stop on the conflicts.
  invoke("mergePrimary", WorktreeScopedPayloadSchema, MergeBranchResultSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // The way on from a split with the upstream that conflicts: merge it
  // and stop on the conflicts.
  invoke(
    "mergeUpstream",
    WorktreeScopedPayloadSchema,
    MergeBranchResultSchema,
    {
      tracksProjectUsage: true,
      remote: true,
      gated: true,
      grant: "changeCode",
    },
  ),
  worktreeMutation("push"),
  worktreeMutation("pull"),
  worktreeMutation("pushForce"),
  worktreeMutation("overwrite"),
  worktreeMutation("publish"),
  worktreeMutation("pullAndPush"),
  worktreeMutation("syncWithPrimary"),
  worktreeMutation("switchToPrimaryAndDeleteBranch"),
  broadcast("lifecyclePhase", WorktreeLifecyclePhaseSchema, { remote: true }),
  broadcast("carryOverComplete", WorktreeCarryOverCompleteSchema, {
    remote: true,
  }),
  broadcast("removal", WorktreeRemovalSchema, {
    remote: true,
  }),
);
