import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke } from "../contract.ts";
import {
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
} from "../schemas/index.ts";

// Every worktree-scoped git mutation shares this contract; naming it
// once means a new one can't silently miss tracksProjectUsage.
const worktreeMutation = <const Key extends string>(key: Key) =>
  invoke(key, WorktreeScopedPayloadSchema, WorktreeSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeCode",
  });

export const worktreesContract = defineContract(
  "worktrees",
  "host",
  invoke("list", ProjectScopedPayloadSchema, Schema.Array(WorktreeSchema), {
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
    movesHostState: false,
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
  // Answers with the fresh status so a tick settles in one round trip.
  invoke("setStaged", SetStagedPayloadSchema, Schema.Array(ChangedFileSchema), {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
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
