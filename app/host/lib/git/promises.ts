// Git as Promises, for the Promise code step 7's B5b PR converts (the
// sync source link and the clone from a peer, the mirror's git state
// and transfers, the background fetch, the repo identity): removed by
// that PR, with its last caller (V3.md, the host's Promise adapters).
// Each looks its effect up when called: these modules import each
// other in a cycle, and a face built at load could find one unset.
import * as Processes from "../util/processes";
import * as Clone from "./clone";
import * as Core from "./core";
import * as Operation from "./operation";
import * as Refs from "./refs";
import * as Remotes from "./remotes";
import * as Worktrees from "./worktrees";

export const checkNewCheckoutDestination = (
  ...args: Parameters<typeof Clone.checkNewCheckoutDestination>
) => Processes.run(Clone.checkNewCheckoutDestination(...args));
export const run = (...args: Parameters<typeof Core.run>) =>
  Processes.run(Core.run(...args));
export const runLenient = (...args: Parameters<typeof Core.runLenient>) =>
  Processes.run(Core.runLenient(...args));
export const updateRef = (...args: Parameters<typeof Refs.updateRef>) =>
  Processes.run(Refs.updateRef(...args));
export const deleteRef = (...args: Parameters<typeof Refs.deleteRef>) =>
  Processes.run(Refs.deleteRef(...args));
export const refTip = (...args: Parameters<typeof Refs.refTip>) =>
  Processes.run(Refs.refTip(...args));
export const hasObject = (...args: Parameters<typeof Refs.hasObject>) =>
  Processes.run(Refs.hasObject(...args));
export const hasCommit = (...args: Parameters<typeof Refs.hasCommit>) =>
  Processes.run(Refs.hasCommit(...args));
export const treeOf = (...args: Parameters<typeof Refs.treeOf>) =>
  Processes.run(Refs.treeOf(...args));
export const isAncestor = (...args: Parameters<typeof Refs.isAncestor>) =>
  Processes.run(Refs.isAncestor(...args));
export const localBranchTips = (
  ...args: Parameters<typeof Refs.localBranchTips>
) => Processes.run(Refs.localBranchTips(...args));
export const fetchAllRemotes = (
  ...args: Parameters<typeof Remotes.fetchAllRemotes>
) => Processes.run(Remotes.fetchAllRemotes(...args));
export const snapshotRemoteRefs = (
  ...args: Parameters<typeof Remotes.snapshotRemoteRefs>
) => Processes.run(Remotes.snapshotRemoteRefs(...args));
export const listRemoteEntries = (
  ...args: Parameters<typeof Remotes.listRemoteEntries>
) => Processes.run(Remotes.listRemoteEntries(...args));
export const gitDirOf = (...args: Parameters<typeof Operation.gitDirOf>) =>
  Processes.run(Operation.gitDirOf(...args));
export const listCheckouts = (
  ...args: Parameters<typeof Worktrees.listCheckouts>
) => Processes.run(Worktrees.listCheckouts(...args));
