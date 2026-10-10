import { mkdir, rm } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { checkNewCheckoutDestination } from "./clone";
import { run, runLenient } from "./core";

// Starts a repository at `parentDir/name` and answers its path. It gets
// an empty first commit: a worktree branches off the default branch,
// and an unborn one has nothing to branch off.
export const createRepo = Effect.fnUntraced(function* (
  parentDir: string,
  name: string,
) {
  const dest = yield* checkNewCheckoutDestination(parentDir, name);
  yield* Effect.promise(() => mkdir(dest));
  yield* Effect.gen(function* () {
    // git's own default is still master. Unless the user configured
    // theirs, a new repo starts on main, as one made on GitHub does.
    const configured = (yield* runLenient(dest, [
      "config",
      "--get",
      "init.defaultBranch",
    ])).trim();
    yield* run(dest, ["init", `--initial-branch=${configured || "main"}`]);
    // No hooks: the user's global ones have nothing to check in an
    // empty commit, and one that rejects it would refuse the repo.
    yield* run(dest, [
      "commit",
      "--allow-empty",
      "--no-verify",
      "-m",
      "Initial commit",
    ]);
  }).pipe(
    // The folder holds only what was just made, so a failed start
    // leaves nothing behind and a retry finds the name free (a commit
    // with no git identity set is the likely failure).
    Effect.tapError(() =>
      Effect.promise(() => rm(dest, { recursive: true, force: true })),
    ),
  );
  return dest;
});
