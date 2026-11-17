// The user's login shell, on a Mac and on Linux, for scripts and
// terminals alike.
import { loginShellOf } from "@shigomori/contracts/loginShell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { envVar } from "../environment.ts";
import { findExecutable } from "../executables.ts";

// `program` started with `args`, as a POSIX sh.
const shShell = (program: string, args: ReadonlyArray<string>) => ({
  program,
  args,
  env: {},
  runArgs: (script: string, scriptArgs: ReadonlyArray<string> = []) => [
    ...args,
    "-c",
    script,
    ...scriptArgs,
  ],
  runCommand: (script: string) => [program, ...args, "-c", script],
});

export const makeLogin = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  // The user's login shell (contracts' loginShellOf), run as one (no -i)
  // so .zprofile sets PATH up without zsh's interactive init. The
  // account's reading is the GUI case: a process launchd started may
  // carry no $SHELL at all. /bin/sh only when neither names one.
  const accountShell = spawner
    .string(
      ChildProcess.make("/bin/sh", [
        "-c",
        `dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null || getent passwd "$(id -u)" | cut -d: -f7`,
      ]),
    )
    .pipe(
      // Cached for the service's life, so a lookup that never answers
      // must not hold every launch after it.
      Effect.timeout("5 seconds"),
      Effect.map((out) => out.replace(/^UserShell:/, "").trim()),
      Effect.orElseSucceed(() => ""),
    );
  const loginShell = yield* Effect.cached(
    Effect.gen(function* () {
      const found = yield* loginShellOf({
        environment: "own",
        shellVar: yield* envVar("SHELL"),
        account: accountShell,
      });
      return found === ""
        ? { shell: shShell("/bin/sh", []), login: false }
        : { shell: shShell(found, ["-l"]), login: true };
    }),
  );

  const sh = shShell("/bin/sh", []);
  return {
    script: Effect.map(loginShell, ({ shell }) => shell),
    findForScript: (name: string) =>
      findExecutable(name).pipe(Effect.provideContext(platform)),
    interactive: Effect.map(loginShell, ({ shell, login }) => ({
      program: shell.program,
      args: shell.args,
      env: shell.env,
      syntax: "posix" as const,
      login,
    })),
    // A POSIX shell hands a program its arguments as they are.
    untypable: () => Effect.succeed(Option.none<string>()),
    sh: Effect.succeed(sh),
    // Signals reach the tree here (ProcessTrees), so sh runs as it is.
    containedSh: (script: string, args: ReadonlyArray<string>) =>
      Effect.succeed({
        program: sh.program,
        args: sh.runArgs(script, args),
        env: {},
      }),
  };
});
