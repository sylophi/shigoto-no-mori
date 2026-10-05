import { ttlMapCache } from "../util/ttlCache";
import { execGh } from "./exec";
import { ghUnavailableReason } from "./readiness";
import { getGithubRepoInfo } from "./remote";

// The repo's one-line About text, for the home grid's tiles. Read once
// per launch: an About is rarely edited, and one that is can wait for
// the next. Keyed by the repo (host/owner/repo), so clones of one repo
// share a read. The loader throws on gh failure so only successful
// reads get cached, as repoConfig.ts's does. An empty About reads as
// null.
const repoDescriptionCache = ttlMapCache<string, string | null>(
  Infinity,
  async (slug) => {
    const [host = "", owner, repo] = slug.split("/");
    const { stdout } = await execGh([
      "api",
      "--hostname",
      host,
      `repos/${owner}/${repo}`,
      "--jq",
      '.description // ""',
    ]);
    return stdout.trim() || null;
  },
);

// The repo the app takes the project for (getGithubRepoInfo, the one
// its GitHub links open), not gh's base repo, which for a fork is the
// parent. Null for a repo with no GitHub remote, or with the
// integration off (turning it on invalidates every githubCli query).
// gh missing or signed out and a failed read throw rather than read as
// null, so the renderer, which also keeps the answer for the launch,
// asks again instead of keeping a blank.
export async function getRepoDescription(cwd: string): Promise<string | null> {
  const unavailable = await ghUnavailableReason();
  if (unavailable === "integration-off") return null;
  if (unavailable !== null) throw new Error(`gh is not ready: ${unavailable}`);
  const info = await getGithubRepoInfo(cwd);
  if (info === null) return null;
  return repoDescriptionCache.get(`${info.host}/${info.owner}/${info.repo}`);
}
