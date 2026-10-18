// What a call that changes code is, when a quit should wait on it
// (Engine.changing): the git work a person starts. The others end in
// moments, or nobody pressed them: a page's refresh as it opens
// (git:refreshProject) is not the refresh its button asks for
// (git:fetchProject), and a mirror's push into this repo
// (sync:receiveBundle) is its follower's.
import type { ChangeKind } from "@shigomori/contracts/modules/session";

const kinds: Readonly<Record<string, ChangeKind>> = {
  "git:fetchProject": "fetch",
  "githubCli:createPullRequest": "pullRequest",
  "githubCli:mergePullRequest": "merge",
  "githubCli:publish": "push",
  "githubCli:resolvePullRequestCheckout": "fetch",
  "sync:receiveWorktree": "land",
  "worktrees:applyStash": "unstash",
  "worktrees:checkoutBranch": "checkout",
  "worktrees:cherryPick": "commit",
  "worktrees:commit": "commit",
  "worktrees:continueOperation": "commit",
  "worktrees:convertExternal": "create",
  "worktrees:create": "create",
  "worktrees:delete": "remove",
  "worktrees:deleteStack": "remove",
  "worktrees:mergeBranch": "merge",
  "worktrees:mergePrimary": "merge",
  "worktrees:mergeUpstream": "pull",
  "worktrees:overwrite": "pull",
  "worktrees:publish": "push",
  "worktrees:pull": "pull",
  "worktrees:pullAndPush": "pullAndPush",
  "worktrees:push": "push",
  "worktrees:pushForce": "push",
  "worktrees:relocate": "move",
  "worktrees:rename": "move",
  "worktrees:restoreStash": "unstash",
  "worktrees:revertCommit": "commit",
  "worktrees:rewordCommit": "commit",
  "worktrees:squashCommit": "commit",
  "worktrees:stashChanges": "stash",
  "worktrees:switchToPrimaryAndDeleteBranch": "finish",
  "worktrees:syncWithPrimary": "pull",
};

export const changeKindOf = (channel: string): ChangeKind | undefined =>
  Object.hasOwn(kinds, channel) ? kinds[channel] : undefined;
