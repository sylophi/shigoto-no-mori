// Central registry of TanStack Query keys. Every queryKey in the
// renderer should come from here so renames and prefix-based
// invalidations can be audited in one place. Keys are camelCase tuples;
// shared prefixes (e.g. "githubCli") let one invalidateQueries call
// knock out everything in that domain.
const PR_BRANCH_SCOPE = "branch";

export const queryKeys = {
  globalConfig: () => ["globalConfig"] as const,

  projects: () => ["projects"] as const,
  projectsSort: () => ["projectsSort"] as const,
  projectsCollapsed: () => ["projectsCollapsed"] as const,
  sidebarView: () => ["sidebarView"] as const,
  projectIcon: (projectId: string) => ["projectIcon", projectId] as const,

  shigomoriConfig: (projectId: string | null) =>
    ["shigomori", projectId] as const,

  worktrees: (projectId: string | null) => ["worktrees", projectId] as const,
  worktreeData: (projectId: string | null, worktreeId: string | null) =>
    ["worktreeData", projectId, worktreeId] as const,
  worktreeDiff: (projectId: string, worktreeId: string | undefined) =>
    ["worktreeDiff", projectId, worktreeId] as const,
  commitDiff: (
    projectId: string,
    worktreeId: string | undefined,
    hash: string,
  ) => ["commitDiff", projectId, worktreeId, hash] as const,
  pickedWorktreeName: (projectId: string | null) =>
    ["pickedWorktreeName", projectId] as const,

  // Tidy-the-forest data. Split in two because the git facts are cheap
  // and the disk walk is not: one key per worktree lets each size land
  // on its own instead of the page waiting for the slowest checkout.
  worktreeHygiene: (projectId: string | null) =>
    ["worktreeHygiene", projectId] as const,
  worktreeDiskUsage: (projectId: string, worktreeId: string) =>
    ["worktreeDiskUsage", projectId, worktreeId] as const,

  branches: (projectId: string | null) => ["branches", projectId] as const,
  defaultBranch: (projectId: string | null) =>
    ["defaultBranch", projectId] as const,
  branchCommits: (
    projectId: string,
    worktreeId: string,
    headHash: string | undefined,
  ) => ["branchCommits", projectId, worktreeId, headHash] as const,

  packageScripts: (projectId: string | null, worktreeId: string | null) =>
    ["packageScripts", projectId, worktreeId] as const,
  packageScriptSort: (projectId: string | null) =>
    ["packageScriptSort", projectId] as const,

  portPoolInstalled: () => ["portPoolInstalled"] as const,
  cli: () => ["cli"] as const,
  cliShell: () => ["cliShell"] as const,
  portPoolActive: (projectId: string, worktreeId: string) =>
    ["portPoolActive", projectId, worktreeId] as const,

  // Every "launchers" key: detected catalog plus the merged per-project
  // list. Invalidating launchersAll() prefix-matches both.
  launchersAll: () => ["launchers"] as const,
  detectedLaunchers: () => ["launchers", "detected"] as const,
  projectLaunchers: (projectId: string | null) =>
    ["launchers", projectId] as const,

  // All GitHub CLI queries share the "githubCli" prefix so toggling the
  // integration can invalidate the whole subtree in one call.
  githubCliAll: () => ["githubCli"] as const,
  githubCliReadiness: () => ["githubCli", "readiness"] as const,
  repoMergeConfig: (projectId: string) =>
    ["githubCli", "repoMergeConfig", projectId] as const,
  pullRequestDiff: (projectId: string, number: number | undefined) =>
    ["githubCli", "pullRequestDiff", projectId, number] as const,
  // PR queries share a project-scoped prefix so invalidating
  // pullRequestsForProject cascades to both projectPullRequests and
  // any open worktreePullRequest.
  pullRequestsAll: () => ["githubCli", "pullRequests"] as const,
  pullRequestsForProject: (projectId: string) =>
    ["githubCli", "pullRequests", projectId] as const,
  projectPullRequests: (projectId: string) =>
    ["githubCli", "pullRequests", projectId, "project"] as const,
  worktreePullRequest: (projectId: string, branch: string) =>
    ["githubCli", "pullRequests", projectId, PR_BRANCH_SCOPE, branch] as const,
  pullRequestCandidates: (projectId: string) =>
    ["githubCli", "pullRequests", projectId, "candidates"] as const,

  fsListDirectory: (path: string) => ["fs", "listDirectory", path] as const,
  fsIsGitRepo: (path: string) => ["fs", "isGitRepo", path] as const,
  fsListEntries: (path: string) => ["fs", "listEntries", path] as const,
  fsStat: (path: string | null) => ["fs", "stat", path] as const,

  ignoredPaths: (projectId: string | null) =>
    ["ignoredPaths", projectId] as const,
  worktreeIncludeStatus: (projectId: string | null) =>
    ["worktreeIncludeStatus", projectId] as const,

  runtimeInfo: () => ["runtime", "info"] as const,
  updaterState: () => ["updater", "state"] as const,
} as const;

// Matchers live beside the builders they mirror and share their segment
// constants: a predicate that indexes a key by hand silently stops
// matching the moment a segment moves, and nothing fails loudly.
export function isWorktreePullRequestKey(query: {
  queryKey: readonly unknown[];
}): boolean {
  return query.queryKey[3] === PR_BRANCH_SCOPE;
}
