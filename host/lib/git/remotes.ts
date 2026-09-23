import { Effect } from "effect";
import * as policy from "@shared/git/defaultBranch.mts";
import { singleFlight } from "../util/ttlCache";
import {
  type GitFailure,
  promiseRunner,
  promiseStep,
  runEffect,
  runGit,
} from "./core";

// Default-branch policy lives in shared/git/defaultBranch.mts so the
// identity parity harness resolves through the same code. These bind
// it to the app's git runner, under the calling fiber's signal, so an
// interrupted caller stops the probe it was waiting on.
function withPolicy<A>(
  use: (run: policy.GitRunner) => Promise<A>,
): Effect.Effect<A> {
  return Effect.promise((signal) => use(promiseRunner(signal)));
}

export const localBranchExistsEffect = (projectPath: string, branch: string) =>
  withPolicy((run) => policy.localBranchExists(run, projectPath, branch));

export function localBranchExists(
  projectPath: string,
  branch: string,
): Promise<boolean> {
  return runGit(localBranchExistsEffect(projectPath, branch));
}

export const remoteRefExistsEffect = (projectPath: string, ref: string) =>
  withPolicy((run) => policy.remoteRefExists(run, projectPath, ref));

export const listRemotesEffect = (projectPath: string) =>
  withPolicy((run) => policy.listRemotes(run, projectPath));

// Every row of `git remote -v` as a name + URL pair. git emits two rows
// per remote, fetch and push. Both are kept because a remote can push
// somewhere other than it fetches, and callers classifying hosts want to
// see either side. Identical rows are de-duped. A failed listing is no
// remotes.
export const listRemoteEntriesEffect = Effect.fn("remotes.listRemoteEntries")(
  function* (projectPath: string) {
    const stdout = yield* runEffect(projectPath, ["remote", "-v"]);
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
  },
  Effect.orElseSucceed(() => []),
);

export function listRemoteEntries(
  projectPath: string,
): Promise<{ name: string; url: string }[]> {
  return runGit(listRemoteEntriesEffect(projectPath));
}

// Fails with the policy's own Error when the repo has no local branch
// at all to fall back on.
export const resolveDefaultBranchEffect = Effect.fn(
  "remotes.resolveDefaultBranch",
)(function* (projectPath: string, override?: string) {
  return yield* promiseStep((signal) =>
    policy.resolveDefaultBranch(promiseRunner(signal), projectPath, override),
  );
});

export function resolveDefaultBranch(
  projectPath: string,
  override?: string,
): Promise<string> {
  return runGit(resolveDefaultBranchEffect(projectPath, override));
}

// Qualified, fallback-free variant for repo identity. See
// shared/git/defaultBranch.mts for the contract split.
export const resolveDefaultRefEffect = Effect.fn("remotes.resolveDefaultRef")(
  function* (projectPath: string, override?: string) {
    return yield* withPolicy((run) =>
      policy.resolveDefaultRef(run, projectPath, override),
    );
  },
);

// Overlapping callers join a single in-flight fetch per project, so the
// focus-driven sweep and the periodic refresh can't dogpile a slow
// remote. Nothing outlives the run: a settled fetch, success or
// failure, is never served to a later caller (time to live zero), and
// once every caller waiting on a fetch has gone the fetch is
// interrupted, which kills its git.
export const fetchAllRemotesEffect: (
  projectPath: string,
) => Effect.Effect<void, GitFailure> = singleFlight((projectPath: string) =>
  runEffect(projectPath, ["fetch", "--all", "--quiet", "--prune"]).pipe(
    Effect.asVoid,
    Effect.withSpan("remotes.fetchAllRemotes"),
  ),
);

export function fetchAllRemotes(projectPath: string): Promise<void> {
  return runGit(fetchAllRemotesEffect(projectPath));
}

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
export function snapshotRemoteRefsEffect(
  projectPath: string,
): Effect.Effect<string, GitFailure> {
  return runEffect(projectPath, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/remotes/",
  ]);
}

export function snapshotRemoteRefs(projectPath: string): Promise<string> {
  return runGit(snapshotRemoteRefsEffect(projectPath));
}
