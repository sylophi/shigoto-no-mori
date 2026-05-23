import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  type GithubCliReadiness,
  type MergeMethod,
  type PullRequest,
  type PullRequestCheck,
  type PullRequestCheckBucket,
  type PullRequestChecksSummary,
  type PullRequestDetail,
  type PullRequestMergeState,
  PullRequestMergeStateSchema,
  PullRequestStateSchema,
  pullRequestsEqual,
  type RepoMergeConfig,
} from "@shared/schemas";
import { readGlobalConfig } from "./globalConfig";
import { readShigomoriConfig, writeShigomoriConfig } from "./shigomori";

const execFileP = promisify(execFile);

let readinessCache: { value: GithubCliReadiness; expires: number } | null =
  null;
const READINESS_CACHE_TTL_MS = 30_000;

export async function getGithubCliReadiness(): Promise<GithubCliReadiness> {
  const now = Date.now();
  if (readinessCache && readinessCache.expires > now) {
    return readinessCache.value;
  }
  const installed = await isInstalled();
  // `gh auth status` exits non-zero when not signed in. We don't bother
  // probing for auth when `gh` is missing -- there's nothing to ask.
  const authed = installed ? await isAuthed() : false;
  const value: GithubCliReadiness = { installed, authed };
  readinessCache = { value, expires: now + READINESS_CACHE_TTL_MS };
  return value;
}

export function clearGithubCliReadinessCache(): void {
  readinessCache = null;
}

async function isInstalled(): Promise<boolean> {
  try {
    await execFileP("which", ["gh"]);
    return true;
  } catch {
    return false;
  }
}

async function isAuthed(): Promise<boolean> {
  try {
    await execFileP("gh", ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

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

// Toggle + readiness gate any path that's about to spawn `gh`. Returns
// false when the integration is off or gh isn't ready, so callers can
// short-circuit before doing IO.
async function ghReady(): Promise<boolean> {
  const config = await readGlobalConfig();
  if (config.githubCli === false) return false;
  const { installed, authed } = await getGithubCliReadiness();
  return installed && authed;
}

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
  if (!(await ghReady())) return new Map();
  const cached = prCache.get(cwd);
  if (cached && cached.expires > Date.now()) return cached.value;
  return refreshProjectPullRequests(cwd);
}

// Bypass the cache and repopulate. Used by the background sweep.
export async function refreshProjectPullRequests(
  cwd: string,
): Promise<Map<string, PullRequest>> {
  if (!(await ghReady())) return cacheAndReturn(cwd, new Map());
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
  if (!(await ghReady())) return null;
  return runGhPrListDetail(cwd, branch);
}

export function clearProjectPullRequestCache(cwd?: string): void {
  if (cwd) prCache.delete(cwd);
  else prCache.clear();
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
      "number,url,title,state,isDraft,mergeStateStatus,statusCheckRollup",
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
    url: item.detailsUrl ?? item.targetUrl ?? undefined,
  }));
  return {
    number: first.number,
    url: first.url,
    title: first.title,
    state: first.state,
    isDraft: first.isDraft,
    mergeState: first.mergeStateStatus as PullRequestMergeState,
    checks: summarizeChecks(checkList),
    checkList,
  };
}

// Repo-level merge-button settings. Stable across the session in
// practice; cached for an hour so reopening the section is free.
const REPO_MERGE_CONFIG_TTL_MS = 60 * 60_000;
const repoMergeConfigCache = new Map<
  string,
  { value: RepoMergeConfig; expires: number }
>();

const GhRepoMergeConfigSchema = z.object({
  mergeCommitAllowed: z.boolean(),
  squashMergeAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
});

export async function getRepoMergeConfig(
  cwd: string,
): Promise<RepoMergeConfig | null> {
  if (!(await ghReady())) return null;
  const cached = repoMergeConfigCache.get(cwd);
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const { stdout } = await execFileP(
      "gh",
      [
        "repo",
        "view",
        "--json",
        "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
      ],
      { cwd },
    );
    const parsed: unknown = JSON.parse(stdout);
    const validated = GhRepoMergeConfigSchema.safeParse(parsed);
    if (!validated.success) return null;
    const value: RepoMergeConfig = {
      merge: validated.data.mergeCommitAllowed,
      squash: validated.data.squashMergeAllowed,
      rebase: validated.data.rebaseMergeAllowed,
    };
    repoMergeConfigCache.set(cwd, {
      value,
      expires: Date.now() + REPO_MERGE_CONFIG_TTL_MS,
    });
    return value;
  } catch {
    return null;
  }
}

const MERGE_FLAG: Record<MergeMethod, string> = {
  merge: "--merge",
  squash: "--squash",
  rebase: "--rebase",
};

// Performs the actual `gh pr merge` and persists the user's pick into
// the per-project config so the split button defaults to it next time.
// Throws on gh failure -- the renderer surfaces the message inline.
export async function mergePullRequest(opts: {
  projectId: string;
  cwd: string;
  number: number;
  method: MergeMethod;
}): Promise<void> {
  const { projectId, cwd, number, method } = opts;
  if (!(await ghReady())) {
    throw new Error("GitHub CLI isn't ready");
  }
  try {
    await execFileP("gh", ["pr", "merge", String(number), MERGE_FLAG[method]], {
      cwd,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? trimGhError(err.message)
        : "gh pr merge failed";
    throw new Error(message, { cause: err });
  }
  // Best-effort: failure to persist the pref shouldn't fail the merge.
  try {
    const current = (await readShigomoriConfig(projectId).catch(
      () => null,
    )) ?? {
      defaultBranch: "main",
    };
    if (current.lastMergeMethod !== method) {
      await writeShigomoriConfig(projectId, {
        ...current,
        lastMergeMethod: method,
      });
    }
  } catch {
    // swallow
  }
  // The merge changes upstream refs (and the sidebar PR cache) -- evict
  // so the next read sees the merged state.
  prCache.delete(cwd);
}

// gh's stderr tends to be one long line with a `gh:` prefix; the rest
// is usable as-is. Trim noise so the renderer banner stays compact.
function trimGhError(raw: string): string {
  const trimmed = raw.trim();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? trimmed;
  return last.replace(/^gh:\s*/i, "");
}
