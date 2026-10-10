// Ref and object plumbing for the pull orchestration and the mirror's
// git follower. Every argument that reaches argv here is either a
// schema-pinned hex hash / worktree id or an app-built refs/... path;
// --end-of-options pins them to the revision slot anyway, matching the
// house argv discipline (see the engine's Dirty.ts).
import * as Effect from "effect/Effect";
import { run } from "./core";

// The ref must not exist, in update-ref's compare-and-set vocabulary.
export const ZERO_SHA = "0".repeat(40);

// With `expected`, a compare-and-set: the ref moves only while it still
// points there (ZERO_SHA: only while it does not exist).
export const updateRef = (
  projectPath: string,
  ref: string,
  commit: string,
  expected?: string,
) =>
  Effect.asVoid(
    run(projectPath, [
      "update-ref",
      "--end-of-options",
      ref,
      commit,
      ...(expected === undefined ? [] : [expected]),
    ]),
  );

// Absence is fine: update-ref -d on a missing ref exits 0, so every
// error here is real.
export const deleteRef = (projectPath: string, ref: string) =>
  Effect.asVoid(
    run(projectPath, ["update-ref", "-d", "--end-of-options", ref]),
  );

// The commit a ref resolves to, or null when it does not exist.
export const refTip = (cwd: string, ref: string) =>
  run(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref]).pipe(
    Effect.map((out): string | null => out.trim()),
    Effect.orElseSucceed(() => null),
  );

// Whether an object (any type, or a peeled form like `<sha>^{tree}`)
// exists in the repository.
export const hasObject = (cwd: string, object: string) =>
  run(cwd, ["cat-file", "-e", "--end-of-options", object]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

export const hasCommit = (cwd: string, commit: string) =>
  hasObject(cwd, `${commit}^{commit}`);

// The object name a revision resolves to. Fails when it doesn't.
export const verifyRev = (cwd: string, rev: string) =>
  Effect.map(
    run(cwd, ["rev-parse", "--verify", "--end-of-options", rev]),
    (out) => out.trim(),
  );

// The upstream by its name ("origin/feature"), or null without one.
export const upstreamName = (cwd: string) =>
  run(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).pipe(
    Effect.map((out): string | null => out.trim() || null),
    Effect.orElseSucceed(() => null),
  );

// How many commits `revs` name, `flags` (rev-list's own) applied.
export const countCommits = (
  cwd: string,
  revs: string[],
  flags: string[] = [],
) =>
  Effect.map(
    run(cwd, ["rev-list", "--count", ...flags, "--end-of-options", ...revs]),
    (out) => Number(out.trim()),
  );

// Leaves out what any remote has, as the engine's unpushed count does.
const NOT_ON_A_REMOTE = ["--not", "--remotes", "--not"];

// HEAD's own commits past `ref`: how many, how many of them are
// merges, and how many no remote has.
export const ownCommitCounts = (cwd: string, ref: string) => {
  const range = [`${ref}..HEAD`];
  return Effect.all(
    {
      own: countCommits(cwd, range),
      merges: countCommits(cwd, range, ["--merges"]),
      unpushed: countCommits(cwd, range, NOT_ON_A_REMOTE),
    },
    { concurrency: "unbounded" },
  );
};

export const treeOf = (cwd: string, commit: string) =>
  verifyRev(cwd, `${commit}^{tree}`);

// merge-base --is-ancestor answers with the exit code: 0 yes, 1 no,
// anything else a real failure.
export const isAncestor = (cwd: string, ancestor: string, descendant: string) =>
  run(cwd, [
    "merge-base",
    "--is-ancestor",
    "--end-of-options",
    ancestor,
    descendant,
  ]).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.exitCode === 1,
      () => Effect.succeed(false),
    ),
  );

// Tips of every local branch, deduped, as `haves` for a thin bundle.
// Capped at the contract's 256-have limit; a repo with more branches
// just gets a slightly less thin bundle.
export const localBranchTips = (projectPath: string) =>
  Effect.map(
    run(projectPath, ["for-each-ref", "--format=%(objectname)", "refs/heads/"]),
    (stdout) => [...new Set(stdout.split("\n").filter(Boolean))].slice(0, 256),
  );
