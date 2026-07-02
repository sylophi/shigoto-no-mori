import { z } from "zod";
import type { RepoMergeConfig } from "@shared/schemas";
import { ttlMapCache } from "../util/ttlCache";
import { execFileP } from "./exec";
import { ghReadyForRepo } from "./remote";

// Repo-level merge-button settings. Stable across the session in
// practice; cached for an hour so reopening the section is free.
const REPO_MERGE_CONFIG_TTL_MS = 60 * 60_000;

const GhRepoMergeConfigSchema = z.object({
  mergeCommitAllowed: z.boolean(),
  squashMergeAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
});

// The loader throws on gh failure or a malformed response so only
// successful reads get cached -- a transient failure shouldn't pin
// "no config" for the full hour.
const repoMergeConfigCache = ttlMapCache<string, RepoMergeConfig>(
  REPO_MERGE_CONFIG_TTL_MS,
  async (cwd) => {
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
    const parsed = GhRepoMergeConfigSchema.parse(JSON.parse(stdout));
    return {
      merge: parsed.mergeCommitAllowed,
      squash: parsed.squashMergeAllowed,
      rebase: parsed.rebaseMergeAllowed,
    };
  },
);

export async function getRepoMergeConfig(
  cwd: string,
): Promise<RepoMergeConfig | null> {
  if (!(await ghReadyForRepo(cwd))) return null;
  try {
    return await repoMergeConfigCache.get(cwd);
  } catch {
    return null;
  }
}
