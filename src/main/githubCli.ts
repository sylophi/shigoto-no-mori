import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  type GithubCliReadiness,
  type PullRequest,
  PullRequestStateSchema,
  pullRequestsEqual,
} from "@shared/schemas";
import { readGlobalConfig } from "./globalConfig";

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
// PR count.
export async function getWorktreePullRequest(
  cwd: string,
  branch: string,
): Promise<PullRequest | null> {
  if (!(await ghReady())) return null;
  const rows = await runGhPrList(cwd, ["--head", branch, "--limit", "1"]);
  const first = rows?.[0];
  return first ? toPullRequest(first) : null;
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
