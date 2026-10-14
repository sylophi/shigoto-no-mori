import * as Schema from "effect/Schema";
import type { ContractSchema } from "../codec.ts";
import { push, defineContract, invoke, view } from "../contract.ts";
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
  DescribeWorktreePayloadSchema,
  DiscardChangesPayloadSchema,
  DiscardChangesResultSchema,
  DiscardHunksPayloadSchema,
  DropStashPayloadSchema,
  FileDiffPayloadSchema,
  FileHunksPayloadSchema,
  FileHunksSchema,
  GitOperationStateSchema,
  ListCommitsPayloadSchema,
  MergeBranchPayloadSchema,
  MergeBranchResultSchema,
  MergePreviewPayloadSchema,
  MergePreviewSchema,
  ProjectScopedPayloadSchema,
  RelocateWorktreePayloadSchema,
  RenameWorktreePayloadSchema,
  RenameBranchPayloadSchema,
  ResetHardPayloadSchema,
  ResetHardResultSchema,
  ResetSoftPayloadSchema,
  ResetSoftResultSchema,
  ReadBlobPayloadSchema,
  ReadWorktreeFilePayloadSchema,
  RestoreDiscardPayloadSchema,
  RestoreStashPayloadSchema,
  ResolveConflictPayloadSchema,
  RewordCommitPayloadSchema,
  SetAutoPullPayloadSchema,
  SetShelvedPayloadSchema,
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

// So a new mutation can't silently miss tracksProjectUsage.
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
  // A mirror into this device looks its copy up here.
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
  // A mirror's stop removes the copy on the copy's device.
  invoke("delete", DeleteWorktreePayloadSchema, DeleteWorktreeResultSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
    invitable: "copy",
  }),
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
  // The open pull request's, through this device's gh, when there is one.
  invoke("describe", DescribeWorktreePayloadSchema, WorktreeSchema, {
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
  invoke("setAutoPull", SetAutoPullPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // For a turn whose end no hook reported.
  worktreeMutation("idleAgents"),
  worktreeMutationOf("unbindAgent", AgentSessionPayloadSchema),
  // In a terminal on this machine, so like a launch not served to peers.
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
  // A read, but it discloses any file (an ignored .env included).
  invoke("readFile", ReadWorktreeFilePayloadSchema, WorktreeFileSchema, {
    remote: true,
    gated: true,
    grant: "browseFiles",
  }),
  // Ungated like the diffs, which already show any blob's text.
  invoke("readBlob", ReadBlobPayloadSchema, WorktreeFileSchema, {
    remote: true,
    gated: false,
  }),
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
  view("watchFileDiff", FileDiffPayloadSchema, Schema.String, {
    remote: true,
    gated: false,
  }),
  view("watchFileHunks", FileHunksPayloadSchema, FileHunksSchema, {
    remote: true,
    gated: false,
  }),
  view("watchOperation", WorktreeScopedPayloadSchema, GitOperationStateSchema, {
    remote: true,
    gated: false,
  }),
  // Answers once each read landed.
  invoke("refreshChangeStatus", WorktreeScopedPayloadSchema, Schema.Void, {
    remote: true,
    gated: false,
  }),
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
  invoke("resetHard", ResetHardPayloadSchema, ResetHardResultSchema, {
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
  view("watchBranchHistory", WorktreeScopedPayloadSchema, BranchHistorySchema, {
    remote: true,
    gated: false,
  }),
  // As a pull request would show it.
  invoke("branchDiff", WorktreeScopedPayloadSchema, Schema.String, {
    remote: true,
    gated: false,
  }),
  // A cherry-pick's worktree is the one the commit lands on.
  worktreeMutationOf("revertCommit", CommitDiffPayloadSchema),
  worktreeMutationOf("cherryPick", CommitDiffPayloadSchema),
  worktreeMutationOf("rewordCommit", RewordCommitPayloadSchema),
  worktreeMutationOf("squashCommit", SquashCommitPayloadSchema),
  view(
    "watchStashes",
    WorktreeScopedPayloadSchema,
    Schema.Array(StashEntrySchema),
    { remote: true, gated: false },
  ),
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
  invoke("restoreStash", RestoreStashPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  worktreeMutationOf("resolveConflict", ResolveConflictPayloadSchema),
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
  // After a sync from primary conflicts: merge anyway and stop on them.
  invoke("mergePrimary", WorktreeScopedPayloadSchema, MergeBranchResultSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // After a split with the upstream conflicts.
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
  push("lifecyclePhase", WorktreeLifecyclePhaseSchema, { remote: true }),
  push("carryOverComplete", WorktreeCarryOverCompleteSchema, {
    remote: true,
  }),
  push("removal", WorktreeRemovalSchema, {
    remote: true,
  }),
  // The host's own signal to its views.
  push("filesChanged", ProjectScopedPayloadSchema),
);
