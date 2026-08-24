// Central registry of TanStack Query keys. Every queryKey in the
// renderer should come from here so renames and prefix-based
// invalidations can be audited in one place. Keys are camelCase tuples;
// shared prefixes (e.g. "githubCli") let one invalidateQueries call
// knock out everything in that domain.
//
// Two scopes. Host-scoped keys describe a machine's git, fs,
// processes, worktrees or config (including preferences that persist
// in the host's per-root state.json) and open with a constant "host"
// sentinel followed by a device id, so a second device's data can
// enter the cache without colliding and scope stays decidable from the
// tuple alone. Client-scoped keys are window/session-local only
// (runtimeInfo, updaterState) and never get either.
const PR_BRANCH_SCOPE = "branch";
const HOST_SCOPE = "host";

// The local device's id, delivered synchronously by the preload bridge
// (main passes it via additionalArguments), so it is a constant before
// any module can build a key. Module-level rather than a builder
// parameter so single-device call sites stay unchanged. When remote
// devices land, host builders can grow an explicit deviceId argument
// that defaults to this one.
const localDeviceId: string = window.api.deviceId;

// A host-scoped tuple: the sentinel, the device id, then the segments
// the builder names. Prefix invalidation through these builders still
// works because the id is a constant within a session.
function host<const T extends readonly unknown[]>(
  ...segments: T
): readonly ["host", string, ...T] {
  return [HOST_SCOPE, localDeviceId, ...segments];
}

// Domain segment of a key: the first element, or the third on
// host-scoped keys, which carry the sentinel and a device id ahead of
// it. Keyed off the sentinel, not the local id, so a remote device's
// key classifies the same as ours. Predicates that classify keys by
// domain go through this instead of indexing around the prefix by
// hand.
export function queryKeyDomain(queryKey: readonly unknown[]): unknown {
  return queryKey[0] === HOST_SCOPE ? queryKey[2] : queryKey[0];
}

export const queryKeys = {
  globalConfig: () => host("globalConfig"),

  projects: () => host("projects"),
  projectsSort: () => host("projectsSort"),
  projectsCollapsed: () => host("projectsCollapsed"),
  sidebarView: () => host("sidebarView"),
  projectIcon: (projectId: string) => host("projectIcon", projectId),

  shigomoriConfig: (projectId: string | null) => host("shigomori", projectId),

  worktrees: (projectId: string | null) => host("worktrees", projectId),
  worktreeData: (projectId: string | null, worktreeId: string | null) =>
    host("worktreeData", projectId, worktreeId),
  worktreeDiff: (projectId: string, worktreeId: string | undefined) =>
    host("worktreeDiff", projectId, worktreeId),
  commitDiff: (
    projectId: string,
    worktreeId: string | undefined,
    hash: string,
  ) => host("commitDiff", projectId, worktreeId, hash),
  pickedWorktreeName: (projectId: string | null) =>
    host("pickedWorktreeName", projectId),

  // Tidy-the-forest data. Split in two because the git facts are cheap
  // and the disk walk is not: one key per worktree lets each size land
  // on its own instead of the page waiting for the slowest checkout.
  worktreeHygiene: (projectId: string | null) =>
    host("worktreeHygiene", projectId),
  worktreeDiskUsage: (projectId: string, worktreeId: string) =>
    host("worktreeDiskUsage", projectId, worktreeId),

  branches: (projectId: string | null) => host("branches", projectId),
  defaultBranch: (projectId: string | null) => host("defaultBranch", projectId),
  branchCommits: (
    projectId: string,
    worktreeId: string,
    headHash: string | undefined,
  ) => host("branchCommits", projectId, worktreeId, headHash),

  packageScripts: (projectId: string | null, worktreeId: string | null) =>
    host("packageScripts", projectId, worktreeId),
  packageScriptSort: (projectId: string | null) =>
    host("packageScriptSort", projectId),

  portPoolInstalled: () => host("portPoolInstalled"),
  cli: () => host("cli"),
  cliShell: () => host("cliShell"),
  portPoolActive: (projectId: string, worktreeId: string) =>
    host("portPoolActive", projectId, worktreeId),

  // Every "launchers" key: detected catalog plus the merged per-project
  // list. Invalidating launchersAll() prefix-matches both.
  launchersAll: () => host("launchers"),
  detectedLaunchers: () => host("launchers", "detected"),
  projectLaunchers: (projectId: string | null) => host("launchers", projectId),

  // All GitHub CLI queries share the "githubCli" prefix so toggling the
  // integration can invalidate the whole subtree in one call.
  githubCliAll: () => host("githubCli"),
  githubCliReadiness: () => host("githubCli", "readiness"),
  repoMergeConfig: (projectId: string) =>
    host("githubCli", "repoMergeConfig", projectId),
  pullRequestDiff: (projectId: string, number: number | undefined) =>
    host("githubCli", "pullRequestDiff", projectId, number),
  // PR queries share a project-scoped prefix so invalidating
  // pullRequestsForProject cascades to both projectPullRequests and
  // any open worktreePullRequest.
  pullRequestsAll: () => host("githubCli", "pullRequests"),
  pullRequestsForProject: (projectId: string) =>
    host("githubCli", "pullRequests", projectId),
  projectPullRequests: (projectId: string) =>
    host("githubCli", "pullRequests", projectId, "project"),
  worktreePullRequest: (projectId: string, branch: string) =>
    host("githubCli", "pullRequests", projectId, PR_BRANCH_SCOPE, branch),
  pullRequestCandidates: (projectId: string) =>
    host("githubCli", "pullRequests", projectId, "candidates"),

  fsListDirectory: (path: string) => host("fs", "listDirectory", path),
  fsIsGitRepo: (path: string) => host("fs", "isGitRepo", path),
  fsListEntries: (path: string) => host("fs", "listEntries", path),
  fsStat: (path: string | null) => host("fs", "stat", path),

  ignoredPaths: (projectId: string | null) => host("ignoredPaths", projectId),
  worktreeIncludeStatus: (projectId: string | null) =>
    host("worktreeIncludeStatus", projectId),

  runtimeInfo: () => ["runtime", "info"] as const,
  updaterState: () => ["updater", "state"] as const,
} as const;

// Matchers live beside the builders they mirror and share their segment
// constants: a predicate that indexes a key by hand silently stops
// matching the moment a segment moves, and nothing fails loudly.
// Deriving length and scope position from a sample built key keeps the
// match exact (a projectId literally named "branch" can't slip in) and
// immune to the builder growing at either end.
const sampleWorktreePullRequestKey = queryKeys.worktreePullRequest("p", "b");
const worktreePullRequestKeyLength = sampleWorktreePullRequestKey.length;
const prBranchScopeIndex =
  sampleWorktreePullRequestKey.indexOf(PR_BRANCH_SCOPE);

export function isWorktreePullRequestKey(query: {
  queryKey: readonly unknown[];
}): boolean {
  return (
    query.queryKey.length === worktreePullRequestKeyLength &&
    query.queryKey[prBranchScopeIndex] === PR_BRANCH_SCOPE
  );
}
