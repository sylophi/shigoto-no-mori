import * as Schema from "effect/Schema";
import type { ChangeKind } from "./session.ts";
import {
  type ContractSchema,
  push,
  defineContract,
  invoke,
  view,
  gatedBy,
  trackedCodeChange,
  ungated,
} from "../contract.ts";
import {
  AgentSessionPayloadSchema,
  ApplyStashPayloadSchema,
  BranchDiffPayloadSchema,
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
  LaunchedSchema,
  ListCommitsPayloadSchema,
  MergeBranchPayloadSchema,
  MergeBranchResultSchema,
  MergePreviewPayloadSchema,
  MergePreviewSchema,
  ProjectScopedPayloadSchema,
  RelocateWorktreePayloadSchema,
  RelocationPlanPayloadSchema,
  RelocationPlanSchema,
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
  busy?: ChangeKind,
) =>
  invoke(key, payload, WorktreeSchema, {
    ...trackedCodeChange,
    ...(busy === undefined ? {} : { busy }),
  });
const worktreeMutation = <const Key extends string>(
  key: Key,
  busy?: ChangeKind,
) => worktreeMutationOf(key, WorktreeScopedPayloadSchema, busy);

export const worktreesContract = defineContract(
  "worktrees",
  { scope: "host", version: 1 },
  // A mirror into this device looks its copy up here.
  invoke(
    "list",
    ProjectScopedPayloadSchema,
    Schema.Array(WorktreeSchema),
    ungated,
  ),
  view(
    "watch",
    ProjectScopedPayloadSchema,
    Schema.Array(WorktreeSchema),
    ungated,
  ),
  invoke("create", CreateWorktreePayloadSchema, CreateWorktreeResultSchema, {
    ...trackedCodeChange,
    busy: "create",
  }),
  invoke(
    "convertExternal",
    ConvertExternalPayloadSchema,
    CreateWorktreeResultSchema,
    { ...trackedCodeChange, busy: "create" },
  ),
  invoke("relocate", RelocateWorktreePayloadSchema, WorktreeSchema, {
    ...trackedCodeChange,
    busy: "move",
  }),
  invoke(
    "relocationPlan",
    RelocationPlanPayloadSchema,
    RelocationPlanSchema,
    ungated,
  ),
  invoke("rename", RenameWorktreePayloadSchema, WorktreeSchema, {
    ...trackedCodeChange,
    busy: "move",
  }),
  // A mirror's stop removes the copy on the copy's device.
  invoke("delete", DeleteWorktreePayloadSchema, DeleteWorktreeResultSchema, {
    ...trackedCodeChange,
    busy: "remove",
  }),
  invoke("deleteStack", DeleteStackPayloadSchema, DeleteStackResultSchema, {
    ...trackedCodeChange,
    busy: "remove",
  }),
  invoke(
    "renameBranch",
    RenameBranchPayloadSchema,
    WorktreeSchema,
    trackedCodeChange,
  ),
  // The open pull request's, through this device's gh, when there is one.
  invoke(
    "describe",
    DescribeWorktreePayloadSchema,
    WorktreeSchema,
    trackedCodeChange,
  ),
  invoke(
    "setShelved",
    SetShelvedPayloadSchema,
    WorktreeSchema,
    trackedCodeChange,
  ),
  invoke(
    "setAutoPull",
    SetAutoPullPayloadSchema,
    WorktreeSchema,
    trackedCodeChange,
  ),
  // For a turn whose end no hook reported.
  worktreeMutation("idleAgents"),
  worktreeMutationOf("unbindAgent", AgentSessionPayloadSchema),
  // In a terminal on this machine, so like a launch not served to peers.
  invoke("resumeAgent", AgentSessionPayloadSchema, LaunchedSchema, {
    tracksProjectUsage: true,
    remote: false,
  }),
  invoke("checkoutBranch", CheckoutBranchPayloadSchema, WorktreeSchema, {
    ...trackedCodeChange,
    busy: "checkout",
  }),
  // A read, but it discloses any file (an ignored .env included).
  invoke(
    "readFile",
    ReadWorktreeFilePayloadSchema,
    WorktreeFileSchema,
    gatedBy("browseFiles"),
  ),
  // Ungated like the diffs, which already show any blob's text.
  invoke("readBlob", ReadBlobPayloadSchema, WorktreeFileSchema, ungated),
  invoke(
    "changeStatus",
    WorktreeScopedPayloadSchema,
    Schema.Array(ChangedFileSchema),
    ungated,
  ),
  view(
    "watchChangeStatus",
    WorktreeScopedPayloadSchema,
    Schema.Array(ChangedFileSchema),
    ungated,
  ),
  view("watchFileDiff", FileDiffPayloadSchema, Schema.String, ungated),
  view("watchFileHunks", FileHunksPayloadSchema, FileHunksSchema, ungated),
  view(
    "watchOperation",
    WorktreeScopedPayloadSchema,
    GitOperationStateSchema,
    ungated,
  ),
  // Answers once each read landed.
  invoke(
    "refreshChangeStatus",
    WorktreeScopedPayloadSchema,
    Schema.Void,
    ungated,
  ),
  invoke(
    "discardHunks",
    DiscardHunksPayloadSchema,
    DiscardChangesResultSchema,
    trackedCodeChange,
  ),
  invoke("commit", CommitChangesPayloadSchema, CommitChangesResultSchema, {
    ...trackedCodeChange,
    busy: "commit",
  }),
  invoke(
    "discardChanges",
    DiscardChangesPayloadSchema,
    DiscardChangesResultSchema,
    trackedCodeChange,
  ),
  invoke(
    "restoreDiscard",
    RestoreDiscardPayloadSchema,
    WorktreeSchema,
    gatedBy("changeCode"),
  ),
  invoke(
    "commitMessage",
    CommitDiffPayloadSchema,
    CommitMessageSchema,
    ungated,
  ),
  invoke(
    "resetSoft",
    ResetSoftPayloadSchema,
    ResetSoftResultSchema,
    trackedCodeChange,
  ),
  invoke(
    "resetHard",
    ResetHardPayloadSchema,
    ResetHardResultSchema,
    trackedCodeChange,
  ),
  invoke("commitDiff", CommitDiffPayloadSchema, Schema.String, ungated),
  invoke(
    "listCommits",
    ListCommitsPayloadSchema,
    Schema.Array(CommitSummarySchema),
    ungated,
  ),
  view(
    "watchBranchHistory",
    WorktreeScopedPayloadSchema,
    BranchHistorySchema,
    ungated,
  ),
  // As a pull request would show it, against the primary ref or `base`.
  invoke("branchDiff", BranchDiffPayloadSchema, Schema.String, ungated),
  // A cherry-pick's worktree is the one the commit lands on.
  worktreeMutationOf("revertCommit", CommitDiffPayloadSchema, "commit"),
  worktreeMutationOf("cherryPick", CommitDiffPayloadSchema, "commit"),
  worktreeMutationOf("rewordCommit", RewordCommitPayloadSchema, "commit"),
  worktreeMutationOf("squashCommit", SquashCommitPayloadSchema, "commit"),
  view(
    "watchStashes",
    WorktreeScopedPayloadSchema,
    Schema.Array(StashEntrySchema),
    ungated,
  ),
  invoke("stashDiff", DropStashPayloadSchema, Schema.String, ungated),
  worktreeMutationOf("stashChanges", StashChangesPayloadSchema, "stash"),
  worktreeMutationOf("applyStash", ApplyStashPayloadSchema, "unstash"),
  invoke(
    "dropStash",
    DropStashPayloadSchema,
    VoidSchema,
    gatedBy("changeCode"),
  ),
  invoke("restoreStash", RestoreStashPayloadSchema, VoidSchema, {
    ...gatedBy("changeCode"),
    busy: "unstash",
  }),
  worktreeMutationOf("resolveConflict", ResolveConflictPayloadSchema),
  invoke(
    "mergePreview",
    MergePreviewPayloadSchema,
    MergePreviewSchema,
    ungated,
  ),
  invoke("mergeBranch", MergeBranchPayloadSchema, MergeBranchResultSchema, {
    ...trackedCodeChange,
    busy: "merge",
  }),
  worktreeMutation("continueOperation", "commit"),
  worktreeMutation("abortOperation"),
  // After a sync from primary conflicts: merge anyway and stop on them.
  invoke("mergePrimary", WorktreeScopedPayloadSchema, MergeBranchResultSchema, {
    ...trackedCodeChange,
    busy: "merge",
  }),
  // After a split with the upstream conflicts.
  invoke(
    "mergeUpstream",
    WorktreeScopedPayloadSchema,
    MergeBranchResultSchema,
    { ...trackedCodeChange, busy: "pull" },
  ),
  worktreeMutation("push", "push"),
  worktreeMutation("pull", "pull"),
  worktreeMutation("pushForce", "push"),
  worktreeMutation("overwrite", "pull"),
  worktreeMutation("publish", "push"),
  worktreeMutation("pullAndPush", "pullAndPush"),
  worktreeMutation("syncWithPrimary", "pull"),
  worktreeMutation("switchToPrimaryAndDeleteBranch", "finish"),
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
