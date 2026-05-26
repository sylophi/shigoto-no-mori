import { z } from "zod";
import type { RepoMergeConfig } from "@shared/schemas";
import { execFileP } from "./exec";
import { ghReadyForRepo } from "./remote";

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
  if (!(await ghReadyForRepo(cwd))) return null;
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
