import type { GithubCliReadiness } from "@shared/schemas";
import { readGlobalConfig } from "../config/global";
import { execFileP } from "./exec";

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

// Toggle + readiness gate any path that's about to spawn `gh`. Returns
// false when the integration is off or gh isn't ready, so callers can
// short-circuit before doing IO.
export async function ghReady(): Promise<boolean> {
  const config = await readGlobalConfig();
  if (config.githubCli === false) return false;
  const { installed, authed } = await getGithubCliReadiness();
  return installed && authed;
}
