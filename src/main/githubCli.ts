// GitHub CLI integration detection. The integration is "ready" when
// the `gh` binary is on PATH and the user is authenticated. We split
// the two so the UI can tell the user which step to take next.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GithubCliReadiness } from "@shared/schemas";

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
