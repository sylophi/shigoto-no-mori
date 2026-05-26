// Public surface of the gh integration. Each domain owns its file:
// readiness probes, repo gating, PR listing/detail, repo merge config,
// and merge/draft/diff actions. Internal helpers (ghReady,
// ghReadyForRepo, execFileP, trimGhError) stay private to the folder.
export { getGithubCliReadiness } from "./readiness";
export {
  getWorktreePullRequest,
  listProjectPullRequests,
  pullRequestMapsEqual,
  readCachedProjectPullRequests,
  refreshProjectPullRequests,
} from "./pullRequests";
export { getRepoMergeConfig } from "./repoConfig";
export {
  getPullRequestDiff,
  mergePullRequest,
  setPullRequestDraft,
} from "./actions";
