import type { GhUnavailableReason, GithubCliReadiness } from "@shared/schemas";
import { readGlobalConfig } from "../config/global";
import { binaryOnPath } from "../util/binaries";
import { ttlValueCache } from "../util/ttlCache";
import { execGh } from "./exec";

const READINESS_CACHE_TTL_MS = 30_000;

const readinessCache = ttlValueCache<GithubCliReadiness>(
  READINESS_CACHE_TTL_MS,
  async () => {
    const installed = await binaryOnPath("gh");
    // `gh auth status` exits non-zero when not signed in. We don't bother
    // probing for auth when `gh` is missing -- there's nothing to ask.
    const authed = installed ? await isAuthed() : false;
    return { installed, authed };
  },
);

export function getGithubCliReadiness(): Promise<GithubCliReadiness> {
  return readinessCache.get();
}

async function isAuthed(): Promise<boolean> {
  try {
    await execGh(["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

// Toggle + readiness gate any path that's about to spawn `gh`. Returns
// false when the integration is off or gh isn't ready, so callers can
// short-circuit before doing IO.
export async function ghReady(): Promise<boolean> {
  return (await ghUnavailableReason()) === null;
}

// Same gate, but says which check failed. Surfaces that explain
// themselves instead of just hiding (the new-worktree PR mode) use this.
// Everything else takes the boolean.
export async function ghUnavailableReason(): Promise<GhUnavailableReason | null> {
  const config = await readGlobalConfig();
  if (config.githubCli === false) return "integration-off";
  const { installed, authed } = await getGithubCliReadiness();
  if (!installed) return "gh-missing";
  if (!authed) return "gh-signed-out";
  return null;
}
