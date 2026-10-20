// The post-checkout hook a --no-checkout add skipped, run as git
// would have.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { envVar } from "../environment.ts";
import * as Git from "../Git.ts";
import { splitZ } from "../gitParse.ts";
import { captureToFiles } from "../processes.ts";
import { HookFailed } from "./documents.ts";

export const makeHook = Effect.gen(function* () {
  const git = yield* Git.Git;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // Runs post-checkout as `git worktree add` does after its checkout:
  // every hook `git hook list` names, in its order, in the new worktree,
  // with GIT_DIR and GIT_WORK_TREE unset. `git hook run` would export
  // GIT_DIR, which points a hook's git in other repositories at this one.
  const runPostCheckoutHook = Effect.fnUntraced(function* (
    worktree: string,
    head: string,
  ) {
    const args = ["0".repeat(head.length), head, "1"];
    // Most repos have no hooks: `hook list` says so before anything else
    // is asked.
    const hooksDir = yield* Effect.cached(git.gitPath(worktree, "hooks"));
    const listed = yield* git
      .run(worktree, ["hook", "list", "-z", "post-checkout"])
      .pipe(Effect.result);
    let list: string;
    if (Result.isSuccess(listed)) list = listed.success;
    else if (
      listed.failure instanceof Git.GitCommandError &&
      Git.stderrOf(listed.failure).includes("no hooks found")
    ) {
      return;
    } else {
      // A git without `hook list` has no config hooks either, only the
      // hooks folder's, which runs when it's executable.
      const hook = yield* fs
        .stat(path.join(yield* hooksDir, "post-checkout"))
        .pipe(Effect.option);
      list =
        Option.isSome(hook) && (hook.value.mode & 0o111) !== 0
          ? "hook from hookdir"
          : "";
    }
    const names = splitZ(list);
    if (names.length === 0) return;
    const execPath = (yield* git.run(worktree, ["--exec-path"])).trim();
    const dir = yield* fs
      .realPath(worktree)
      .pipe(Effect.orElseSucceed(() => worktree));
    const searched = yield* envVar("PATH");
    // The environment git gives its hooks: its exec path exported and
    // first on PATH, no prefix.
    const hookEnv = {
      GIT_EXEC_PATH: execPath,
      GIT_PREFIX: "",
      PATH: `${execPath}:${searched}`,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
    };
    // A script without a #! line runs as sh's own, as git hands it to sh.
    const run = (command: string, commandArgs: ReadonlyArray<string>) =>
      captureToFiles(spawner, command, commandArgs, {
        all: true,
        cwd: dir,
        env: hookEnv,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.map(({ code, stdout }) =>
          code === 0
            ? Option.none<HookFailed>()
            : Option.some(
                new HookFailed({
                  cause: new Error(
                    new TextDecoder().decode(stdout).trim() ||
                      `exit status ${code}`,
                  ),
                }),
              ),
        ),
        Effect.catch((error) =>
          Effect.succeed(Option.some(new HookFailed({ cause: error }))),
        ),
      );
    // Like git, every hook runs even after one fails, and the first
    // failure is the result.
    let first: HookFailed | undefined;
    for (const name of names) {
      let failed: Option.Option<HookFailed>;
      if (name === "hook from hookdir") {
        failed = yield* run(path.join(yield* hooksDir, "post-checkout"), args);
      } else {
        // A config hook's command goes through the shell with the hook's
        // arguments after it, as git runs it. The last value wins.
        const commands = yield* git
          .run(worktree, ["config", "-z", "--get-all", `hook.${name}.command`])
          .pipe(Effect.option);
        if (Option.isNone(commands)) continue;
        const values = splitZ(commands.value);
        const command = values.at(-1) ?? "";
        failed = yield* run("/bin/sh", [
          "-c",
          `${command} "$@"`,
          command,
          ...args,
        ]);
      }
      if (first === undefined && Option.isSome(failed)) first = failed.value;
    }
    if (first !== undefined) return yield* first;
  });

  return { runPostCheckoutHook };
});
