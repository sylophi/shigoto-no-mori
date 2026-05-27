// Thin wrappers around the git CLI. Each file owns one slice of the
// surface (worktrees, branches, remotes, diff, sync). Importers should
// keep using `from "."` — this barrel hides the layout.
export { isGitRepo } from "./core";
export {
  fetchAllRemotes,
  listRemotes,
  listRemoteUrls,
  resolveDefaultBranch,
  snapshotRemoteRefs,
} from "./remotes";
export {
  createWorktree,
  deriveProjectName,
  describeWorktree,
  findWorktreeIdentityOrThrow,
  listCommits,
  listWorktreeIdentities,
  listWorktrees,
  pickAvailableWorktreeName,
  pruneStaleWorktrees,
  relocateWorktree,
  removeWorktree,
  removeWorktreeForce,
  worktreeIdFromPath,
} from "./worktrees";
export {
  checkoutBranch,
  createLocalBranch,
  deleteAnyLocalBranch,
  deleteBranchAfterWorktreeRemoval,
  deleteLocalBranch,
  listBranches,
  listIgnoredPaths,
  renameAnyLocalBranch,
  renameBranch,
} from "./branches";
export { getCommitDiff, getWorktreeDiff } from "./diff";
export {
  overwriteFromUpstream,
  publishCurrentBranch,
  pullFastForward,
  pullRebaseOrMergeAndPush,
  pushFastForward,
  pushForceWithLease,
  syncWithPrimary,
} from "./sync";
