import { z } from "zod";
import {
  type PullRequest,
  type PullRequestCheck,
  type PullRequestCheckBucket,
  type PullRequestChecksSummary,
  type PullRequestDetail,
  type PullRequestMergeState,
  PullRequestMergeStateSchema,
  PullRequestStateSchema,
  pullRequestsEqual,
} from "@shared/schemas";
import { execFileP } from "./exec";
import { ghReadyForRepo } from "./remote";

const GhPrListItemSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  state: PullRequestStateSchema,
  isDraft: z.boolean(),
  headRefName: z.string(),
});
type GhPrListItem = z.infer<typeof GhPrListItemSchema>;

const PR_CACHE_TTL_MS = 5 * 60_000;
const PR_LIST_LIMIT = 200;
const prCache = new Map<
  string,
  { value: Map<string, PullRequest>; expires: number }
>();

// Runs `gh pr list ...` with the standard JSON projection. Returns the
// parsed rows on success or null on any failure (gh exit, JSON, schema).
async function runGhPrList(
  cwd: string,
  extraArgs: string[],
): Promise<GhPrListItem[] | null> {
  try {
    const { stdout } = await execFileP(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "all",
        ...extraArgs,
        "--json",
        "number,url,title,state,isDraft,headRefName",
      ],
      { cwd },
    );
    const parsed: unknown = JSON.parse(stdout);
    const validated = z.array(GhPrListItemSchema).safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

function toPullRequest(item: GhPrListItem): PullRequest {
  return {
    number: item.number,
    url: item.url,
    title: item.title,
    state: item.state,
    isDraft: item.isDraft,
  };
}

// Indexed by head branch name. The cache is repopulated by the background
// sweep in fetch.ts -- this read path just serves whatever's there.
// Toggle + readiness checks gate the cache too, so flipping the
// integration off takes effect immediately.
export async function listProjectPullRequests(
  cwd: string,
): Promise<Map<string, PullRequest>> {
  if (!(await ghReadyForRepo(cwd))) return new Map();
  const cached = prCache.get(cwd);
  if (cached && cached.expires > Date.now()) return cached.value;
  return refreshProjectPullRequests(cwd);
}

// Bypass the cache and repopulate. Used by the background sweep.
export async function refreshProjectPullRequests(
  cwd: string,
): Promise<Map<string, PullRequest>> {
  if (!(await ghReadyForRepo(cwd))) return cacheAndReturn(cwd, new Map());
  const rows = await runGhPrList(cwd, ["--limit", String(PR_LIST_LIMIT)]);
  if (rows === null) {
    // Transient gh / network failure -- preserve the previous map so the
    // sidebar dots don't blink out on a single bad sweep. Fall through
    // to caching empty only when we've never had a value.
    const previous = prCache.get(cwd)?.value;
    return previous ?? cacheAndReturn(cwd, new Map());
  }
  // gh returns PRs newest-first; first hit per branch wins so we surface
  // the freshest PR when a branch has been reused.
  const map = new Map<string, PullRequest>();
  for (const item of rows) {
    if (map.has(item.headRefName)) continue;
    map.set(item.headRefName, toPullRequest(item));
  }
  return cacheAndReturn(cwd, map);
}

export function readCachedProjectPullRequests(
  cwd: string,
): Map<string, PullRequest> | null {
  return prCache.get(cwd)?.value ?? null;
}

export function pullRequestMapsEqual(
  a: Map<string, PullRequest> | null,
  b: Map<string, PullRequest>,
): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [branch, pa] of a) {
    const pb = b.get(branch);
    if (!pb || !pullRequestsEqual(pa, pb)) return false;
  }
  return true;
}

// Eviction hook for action paths (merge / setDraft) that change state
// the cached map reflects (isDraft, MERGED status, etc).
export function evictProjectPullRequests(cwd: string): void {
  prCache.delete(cwd);
}

function cacheAndReturn(
  cwd: string,
  value: Map<string, PullRequest>,
): Map<string, PullRequest> {
  prCache.set(cwd, { value, expires: Date.now() + PR_CACHE_TTL_MS });
  return value;
}

// Each rollup item is either a CheckRun or a StatusContext. We keep the
// schema permissive (passthrough + every field optional) because gh
// occasionally inlines extra typenames and we'd rather degrade
// gracefully than reject the whole list.
const StatusCheckRollupItemSchema = z
  .object({
    __typename: z.string().optional(),
    name: z.string().optional(),
    context: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().optional(),
    state: z.string().optional(),
    detailsUrl: z.string().optional(),
    targetUrl: z.string().optional(),
  })
  .passthrough();
type StatusCheckRollupItem = z.infer<typeof StatusCheckRollupItemSchema>;

const GhPrDetailSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  state: PullRequestStateSchema,
  isDraft: z.boolean(),
  mergeStateStatus: PullRequestMergeStateSchema.catch("UNKNOWN"),
  baseRefName: z.string(),
  author: z.object({ login: z.string().optional() }).passthrough().nullish(),
  updatedAt: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  statusCheckRollup: z.array(StatusCheckRollupItemSchema).default([]),
});

const PASSED_CONCLUSIONS = new Set(["SUCCESS"]);
const NEUTRAL_CONCLUSIONS = new Set(["NEUTRAL"]);
const SKIPPED_CONCLUSIONS = new Set(["SKIPPED"]);
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "CANCELLED",
]);

function bucketForItem(item: StatusCheckRollupItem): PullRequestCheckBucket {
  // CheckRun: status describes lifecycle, conclusion the final verdict.
  // StatusContext: a single `state` covers both.
  const typename = item["__typename"];
  if (typename === "StatusContext" || item.state) {
    const state = item.state ?? "";
    if (state === "SUCCESS") return "passed";
    if (state === "FAILURE" || state === "ERROR") return "failing";
    return "pending";
  }
  if (item.status && item.status !== "COMPLETED") return "pending";
  const conclusion = item.conclusion ?? "";
  if (PASSED_CONCLUSIONS.has(conclusion)) return "passed";
  if (NEUTRAL_CONCLUSIONS.has(conclusion)) return "neutral";
  if (SKIPPED_CONCLUSIONS.has(conclusion)) return "skipped";
  if (FAILING_CONCLUSIONS.has(conclusion)) return "failing";
  // Empty / unrecognized conclusion on a COMPLETED check -- safest to
  // treat as pending so the user doesn't merge on an unknown signal.
  return "pending";
}

// detailsUrl/targetUrl are whatever the CI integration wrote: frequently
// an empty string (no details link), occasionally relative, and in the
// worst case a non-web scheme. PullRequestCheckSchema.url requires a real
// URL, and the renderer feeds it to openExternal, so only absolute
// http(s) links make the cut.
function toCheckUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function summarizeChecks(checks: PullRequestCheck[]): PullRequestChecksSummary {
  const summary: PullRequestChecksSummary = {
    total: checks.length,
    passed: 0,
    failing: 0,
    pending: 0,
    neutral: 0,
    skipped: 0,
  };
  for (const c of checks) {
    summary[c.bucket] += 1;
  }
  return summary;
}

// Single-branch lookup for the currently open worktree page. Uncached --
// invalidations from focus / refs-changed must actually hit gh. The
// --head filter is server-side so this stays cheap regardless of repo
// PR count. Returns the rich detail shape (checks + mergeable state)
// since the only consumer is the worktree detail page; the slim
// PullRequest projection is used by the sidebar list path. Throws on
// transient gh / network / parse failure so callers can distinguish
// "no PR" (null) from "we don't know" -- the renderer uses that to
// avoid clobbering the sidebar's project-wide PR map.
export async function getWorktreePullRequest(
  cwd: string,
  branch: string,
): Promise<PullRequestDetail | null> {
  if (!(await ghReadyForRepo(cwd))) return null;
  return runGhPrListDetail(cwd, branch);
}

// Server-side filtering + minimal fields keeps this cheap even on
// huge-PR repos. Returns null when there's no PR for the branch;
// throws on gh / JSON / schema failure so the renderer can
// distinguish "no PR" from "couldn't load."
async function runGhPrListDetail(
  cwd: string,
  branch: string,
): Promise<PullRequestDetail | null> {
  const { stdout } = await execFileP(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      branch,
      "--limit",
      "1",
      "--json",
      "number,url,title,state,isDraft,mergeStateStatus,baseRefName,author,updatedAt,additions,deletions,changedFiles,statusCheckRollup",
    ],
    { cwd },
  );
  const parsed: unknown = JSON.parse(stdout);
  const validated = z.array(GhPrDetailSchema).safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Unexpected gh pr list output for ${branch}: ${validated.error.message}`,
    );
  }
  const first = validated.data[0];
  if (!first) return null;
  const checkList: PullRequestCheck[] = first.statusCheckRollup.map((item) => ({
    name: item.name ?? item.context ?? "check",
    bucket: bucketForItem(item),
    url: toCheckUrl(item.detailsUrl) ?? toCheckUrl(item.targetUrl),
  }));
  return {
    number: first.number,
    url: first.url,
    title: first.title,
    state: first.state,
    isDraft: first.isDraft,
    mergeState: first.mergeStateStatus as PullRequestMergeState,
    baseRefName: first.baseRefName,
    authorLogin: first.author?.login ?? "ghost",
    updatedAt: first.updatedAt,
    additions: first.additions,
    deletions: first.deletions,
    changedFiles: first.changedFiles,
    checks: summarizeChecks(checkList),
    checkList,
  };
}
