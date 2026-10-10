// A repo's remotes and remote-tracking refs, as the app's git runner
// reads them. The primary ref a worktree row is measured against is the
// engine's.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { type GitError, run } from "./core";

const refExists = (projectPath: string, fullRef: string) =>
  run(projectPath, ["show-ref", "--verify", "--quiet", fullRef]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

export const localBranchExists = (projectPath: string, branch: string) =>
  refExists(projectPath, `refs/heads/${branch}`);

export const remoteRefExists = (projectPath: string, ref: string) =>
  refExists(projectPath, `refs/remotes/${ref}`);

export const listRemotes = (projectPath: string) =>
  run(projectPath, ["remote"]).pipe(
    Effect.map((stdout) =>
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
    Effect.orElseSucceed((): string[] => []),
  );

// Every row of `git remote -v` as a name + URL pair. git emits two rows
// per remote, fetch and push. Both are kept because a remote can push
// somewhere other than it fetches, and callers classifying hosts want to
// see either side. Identical rows are de-duped.
export const listRemoteEntries = (projectPath: string) =>
  run(projectPath, ["remote", "-v"]).pipe(
    Effect.map((stdout) => {
      const entries: { name: string; url: string }[] = [];
      const seen = new Set<string>();
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(\S+)\s+(\S+)\s+\(/);
        const name = match?.[1];
        const url = match?.[2];
        if (!name || !url || seen.has(`${name}\t${url}`)) continue;
        seen.add(`${name}\t${url}`);
        entries.push({ name, url });
      }
      return entries;
    }),
    Effect.orElseSucceed((): { name: string; url: string }[] => []),
  );

// Coalesces overlapping callers onto a single in-flight fetch so the
// focus-driven sweep and the periodic refresh can't dogpile a slow
// remote.
const fetchInflight = new Map<string, Deferred.Deferred<void, GitError>>();

export const fetchAllRemotes = (projectPath: string) =>
  Effect.suspend(() => {
    const existing = fetchInflight.get(projectPath);
    if (existing) return Deferred.await(existing);
    const fetching = Deferred.makeUnsafe<void, GitError>();
    fetchInflight.set(projectPath, fetching);
    return run(projectPath, ["fetch", "--all", "--quiet", "--prune"]).pipe(
      Effect.asVoid,
      Effect.onExit((exit) =>
        Effect.sync(() => {
          fetchInflight.delete(projectPath);
          Deferred.doneUnsafe(fetching, exit);
        }),
      ),
    );
  });

// Splits a remote-tracking ref like "origin/main" or "fork/feat/x" into
// (remote, branch). Returns null if no configured remote matches.
// Picks the longest matching prefix so a remote named "origin/foo" wins
// over "origin" for "origin/foo/bar".
export function splitRemoteRefSync(
  ref: string,
  remotes: readonly string[],
): { remote: string; branch: string } | null {
  let best: { remote: string; branch: string } | null = null;
  for (const remote of remotes) {
    const prefix = `${remote}/`;
    if (!ref.startsWith(prefix)) continue;
    if (!best || remote.length > best.remote.length) {
      best = { remote, branch: ref.slice(prefix.length) };
    }
  }
  return best;
}

// Single-string snapshot of every remote-tracking ref + its SHA. Compared
// before/after a fetch to skip the broadcast when nothing actually moved.
export const snapshotRemoteRefs = (projectPath: string) =>
  run(projectPath, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/remotes/",
  ]);
