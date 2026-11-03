import { githubRepoOf } from "@shigomori/contracts/predicates/remoteUrl";
import * as Effect from "effect/Effect";
import * as Git from "@shigomori/engine/Git";

// The remote pointing at the repo `url` belongs to, by name. Fetching a
// PR head needs a name, and neither "origin" nor "the first GitHub
// remote" is a safe stand-in: a fork checkout has both the fork and the
// parent as remotes, gh resolves pull requests against the parent, and
// fetching a head from the wrong one lands different code under the
// right branch name. Pass the PR's own URL. It names the repo gh
// actually answered from.
export const remoteNameForUrl = Effect.fnUntraced(function* (
  cwd: string,
  url: string,
) {
  const target = githubRepoOf(url);
  if (!target) return null;
  for (const entry of yield* (yield* Git.Git).listRemoteEntries(cwd)) {
    const parsed = githubRepoOf(entry.url);
    // GitHub treats owner and repo case-insensitively, and a remote
    // typed by hand often disagrees with the API's casing.
    if (
      parsed &&
      parsed.host === target.host &&
      sameName(parsed.owner, target.owner) &&
      sameName(parsed.repo, target.repo)
    ) {
      return entry.name;
    }
  }
  return null;
});

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
