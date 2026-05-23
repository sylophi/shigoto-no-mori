// Remote sync mutations. Each operates on a single worktree's checkout
// and lets `git` surface any failure as a typed Effect error. The public
// API still returns promises so the rest of the app does not need to know
// about the spike yet.
import { Data, Effect } from "effect";
import { Git, type GitService, runGitProgram, runLenient } from "./core";
import { listRemotes } from "./remotes";

class NoGitRemoteError extends Data.TaggedError("NoGitRemoteError")<{
  readonly projectPath: string;
}> {
  override get message(): string {
    return "No git remote configured";
  }
}

const runGitLenient = (cwd: string, args: string[]) =>
  Effect.promise(() => runLenient(cwd, args)).pipe(Effect.asVoid);

const listRemotesEffect = (projectPath: string) =>
  Effect.promise(() => listRemotes(projectPath));

function runSync(
  effect: Effect.Effect<void, unknown, GitService>,
): Promise<void> {
  return runGitProgram(effect);
}

export async function pushFastForward(worktreePath: string): Promise<void> {
  return runSync(Git.runVoid(worktreePath, ["push"]));
}

export async function pullFastForward(worktreePath: string): Promise<void> {
  return runSync(Git.runVoid(worktreePath, ["pull", "--ff-only"]));
}

export async function pushForceWithLease(worktreePath: string): Promise<void> {
  return runSync(Git.runVoid(worktreePath, ["push", "--force-with-lease"]));
}

// "Overwrite": throw away the local divergence and snap to the upstream.
// Fetch first so `@{u}` reflects the current remote tip.
export async function overwriteFromUpstream(
  worktreePath: string,
): Promise<void> {
  return runSync(
    Effect.gen(function* () {
      yield* Git.runVoid(worktreePath, ["fetch"]);
      yield* Git.runVoid(worktreePath, ["reset", "--hard", "@{u}"]);
    }),
  );
}

// Publish: push the current branch to the first configured remote with
// upstream tracking. `HEAD` resolves to whatever's checked out, and `-u`
// wires up `branch.<name>.{remote,merge}` so subsequent pulls/pushes
// don't need an explicit remote.
export async function publishCurrentBranch(
  worktreePath: string,
  projectPath: string,
): Promise<void> {
  return runSync(
    Effect.gen(function* () {
      const remotes = yield* listRemotesEffect(projectPath);
      const first = remotes[0];
      if (!first) {
        return yield* Effect.fail(new NoGitRemoteError({ projectPath }));
      }
      yield* Git.runVoid(worktreePath, ["push", "-u", first, "HEAD"]);
    }),
  );
}

// Combined resolution for the "diverged but mergeable" state. Tries
// rebase first for linear history; if a per-commit conflict strands the
// rebase, aborts and falls back to a whole-tree merge -- which the
// `merge-tree --write-tree` probe (gating this state) already validated
// as clean. If the fallback merge unexpectedly conflicts too (probe was
// wrong), aborts the merge before propagating so the worktree isn't
// left in a half-merged state.
export async function pullRebaseOrMergeAndPush(
  worktreePath: string,
): Promise<void> {
  return runSync(
    Effect.gen(function* () {
      yield* Git.runVoid(worktreePath, ["fetch"]);
      yield* Git.runVoid(worktreePath, ["rebase", "@{u}"]).pipe(
        Effect.catchAll(() =>
          Effect.gen(function* () {
            // Rebase hit a per-commit conflict. Restore the pre-rebase HEAD and
            // try a whole-tree merge instead.
            yield* runGitLenient(worktreePath, ["rebase", "--abort"]);
            yield* Git.runVoid(worktreePath, ["merge", "@{u}"]).pipe(
              Effect.catchAll((err) =>
                runGitLenient(worktreePath, ["merge", "--abort"]).pipe(
                  Effect.zipRight(Effect.fail(err)),
                ),
              ),
            );
          }),
        ),
      );
      yield* Git.runVoid(worktreePath, ["push"]);
    }),
  );
}
