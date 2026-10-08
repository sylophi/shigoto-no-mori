import * as Schema from "effect/Schema";
import type { RepoMergeConfig } from "@shigomori/contracts/schemas";
import { ttlMapCache } from "../util/ttlCache";
import { execGh } from "./exec";
import { ghReadyForRepo } from "./remote";

// Repo-level merge-button settings. Stable across the session in
// practice; cached for an hour so reopening the section is free.
const REPO_MERGE_CONFIG_TTL_MS = 60 * 60_000;

// One GraphQL read: `gh repo view --json` has the three method flags
// but not autoMergeAllowed. gh fills {owner} and {repo} from the
// repo's remote in field values the way it does in REST paths. The
// same query as the CLI's (cli/cmd_merge.go repoMergeQuery).
const REPO_MERGE_QUERY =
  "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
  "{ mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed } }";

const decodeGhRepoMergeConfig = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Struct({
        mergeCommitAllowed: Schema.Boolean,
        squashMergeAllowed: Schema.Boolean,
        rebaseMergeAllowed: Schema.Boolean,
        autoMergeAllowed: Schema.Boolean,
      }),
    }),
  }),
);

// The loader throws on gh failure or a malformed response so only
// successful reads get cached. A transient failure shouldn't pin
// "no config" for the full hour.
const repoMergeConfigCache = ttlMapCache<string, RepoMergeConfig>(
  REPO_MERGE_CONFIG_TTL_MS,
  async (cwd) => {
    const { stdout } = await execGh(
      [
        "api",
        "graphql",
        "-F",
        "owner={owner}",
        "-F",
        "name={repo}",
        "-f",
        `query=${REPO_MERGE_QUERY}`,
      ],
      { cwd },
    );
    const { repository } = decodeGhRepoMergeConfig(JSON.parse(stdout)).data;
    return {
      merge: repository.mergeCommitAllowed,
      squash: repository.squashMergeAllowed,
      rebase: repository.rebaseMergeAllowed,
      autoMerge: repository.autoMergeAllowed,
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
