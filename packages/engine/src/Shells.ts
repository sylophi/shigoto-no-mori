// Which shell runs what: a project's command lines, a terminal's
// prompt, and the engine's own sh. Each OS picks its own (shells/).
import type { ShellSyntax } from "@shigomori/contracts/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { byPlatform } from "./platform.ts";
import type { NoScriptShell } from "./shells/documents.ts";
import { makeLogin } from "./shells/login.ts";
import { gitBashShArgs, makeWindows } from "./shells/windows.ts";

export { NoScriptShell } from "./shells/documents.ts";

// A shell as started: the program, what it starts with before anything
// else (`-l` for a login shell), and what its environment needs over
// the one it is given.
export type Shell = {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
};

export class Shells extends Context.Service<
  Shells,
  {
    // The shell a project's command lines run in, to their end: setup,
    // teardown, port-pool, the console's scripts, custom launchers. It
    // reads POSIX sh syntax and takes a command line after `-c`.
    readonly script: Effect.Effect<Shell, NoScriptShell>;
    // The shell a terminal runs at its prompt, and `sm cd`'s subshell,
    // and the syntax of what is typed into it (contracts' typedLines).
    readonly interactive: Effect.Effect<
      Shell & { readonly syntax: ShellSyntax }
    >;
    // A POSIX sh, for the engine's own plumbing written in sh.
    readonly sh: Effect.Effect<string, NoScriptShell>;
    // That sh running `script` with `args` (shArgs), for a command line
    // run to its end with no terminal that may leave something running
    // (a lifecycle script, git running the person's hooks). Windows
    // starts it in a job (nativefs job), so ending the process started
    // ends all it started, Git Bash's orphans too, and its success
    // leaves what it left running.
    readonly containedSh: (
      script: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<
      { readonly program: string; readonly args: ReadonlyArray<string> },
      NoScriptShell
    >;
  }
>()("sm/engine/Shells") {}

// `nativefs` is the helper that holds a contained sh on Windows.
const make = (nativefs: string) =>
  Effect.gen(function* () {
    return Shells.of(
      yield* byPlatform({
        darwin: makeLogin,
        linux: makeLogin,
        win32: makeWindows(nativefs),
      }),
    );
  });

export const layer = (nativefs: string) => Layer.effect(Shells, make(nativefs));

// What sh, or the script shell, takes to run `script` with `args` as
// its $0, $1 and on.
export const shArgs = (script: string, args: ReadonlyArray<string>) =>
  byPlatform({
    darwin: () => ["-c", script, ...args],
    linux: () => ["-c", script, ...args],
    win32: () => gitBashShArgs(script, args),
  })();
