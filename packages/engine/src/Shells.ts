// Which shell runs what: a project's command lines, a terminal's
// prompt, and the engine's own sh. Each OS picks its own (shells/).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { byPlatform } from "./platform.ts";
import type { NoScriptShell } from "./shells/documents.ts";
import { makeLogin } from "./shells/login.ts";
import { makeWindows } from "./shells/windows.ts";

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
    // The shell a terminal runs at its prompt, and `sm cd`'s subshell.
    readonly interactive: Effect.Effect<Shell>;
    // A POSIX sh, for the engine's own plumbing written in sh.
    readonly sh: Effect.Effect<string, NoScriptShell>;
    // What sh, or the script shell, takes to run `script` with `args`
    // as its $0, $1 and on.
    readonly shArgs: (
      script: string,
      args: ReadonlyArray<string>,
    ) => ReadonlyArray<string>;
  }
>()("sm/engine/Shells") {}

const make = Effect.gen(function* () {
  return Shells.of(
    yield* byPlatform({
      darwin: makeLogin,
      linux: makeLogin,
      win32: makeWindows,
    }),
  );
});

export const layer = Layer.effect(Shells, make);
