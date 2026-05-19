import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  type GithubCliReadiness,
  type PullRequest,
  PullRequestStateSchema,
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

const PR_CACHE_TTL_MS = 30_000;
const PR_LIST_LIMIT = 200;
const prCache = new Map<
  string,
  { value: Map<string, PullRequest>; expires: number }
>();

// Indexed by head branch name. Cached per-cwd so repeated focus
// refreshes don't respawn gh. Returns an empty map on any failure --
// the PR data is decorative, never load-bearing. The toggle + readiness
// checks gate the cache too, so flipping the integration off takes
// effect immediately rather than waiting out a stale TTL window.
export async function listProjectPullRequests(
  cwd: string,
): Promise<Map<string, PullRequest>> {
  const config = await readGlobalConfig();
  if (config.githubCli === false) return new Map();
  const readiness = await getGithubCliReadiness();
  if (!readiness.installed || !readiness.authed) return new Map();

  const now = Date.now();
  const cached = prCache.get(cwd);
  if (cached && cached.expires > now) return cached.value;

  let stdout: string;
  try {
    const result = await execFileP(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        String(PR_LIST_LIMIT),
        "--json",
        "number,url,title,state,isDraft,headRefName",
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch {
    return cacheAndReturn(cwd, new Map());
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return cacheAndReturn(cwd, new Map());
  }
  const validated = z.array(GhPrListItemSchema).safeParse(parsed);
  if (!validated.success) return cacheAndReturn(cwd, new Map());

  const map = new Map<string, PullRequest>();
  // gh returns PRs newest-first; the first hit per branch wins so we
  // surface the freshest PR if a branch has been reused.
  for (const item of validated.data) {
    if (map.has(item.headRefName)) continue;
    map.set(item.headRefName, {
      number: item.number,
      url: item.url,
      title: item.title,
      state: item.state,
      isDraft: item.isDraft,
    });
  }
  return cacheAndReturn(cwd, map);
}

export function clearProjectPullRequestCache(cwd?: string): void {
  if (cwd) prCache.delete(cwd);
  else prCache.clear();
}

function cacheAndReturn(
  cwd: string,
  value: Map<string, PullRequest>,
): Map<string, PullRequest> {
  prCache.set(cwd, { value, expires: Date.now() + PR_CACHE_TTL_MS });
  return value;
}
