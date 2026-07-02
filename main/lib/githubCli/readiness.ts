import type { GithubCliReadiness } from "@shared/schemas";
import { readGlobalConfig } from "../config/global";
import { binaryOnPath } from "../util/binaries";
import { ttlValueCache } from "../util/ttlCache";
import { execFileP } from "./exec";

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
