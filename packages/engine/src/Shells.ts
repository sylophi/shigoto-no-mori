// Which shell runs what: a project's command lines, a terminal's
// prompt, and the engine's own sh. Each OS picks its own (shells/).
import type { ShellSyntax } from "@shigomori/contracts/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import { byFamily } from "./platform.ts";
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

// A shell that reads POSIX sh, and what makes it run `script` with
// `args` as its $0, $1 and on. Started by Node, it takes `runArgs`
// after its program. Started by another of these with "$@", it is
// `runCommand`, which hands its arguments on as they are. The two
// differ on Windows, where Node hands a program one command line that
// Git Bash's programs read again.
export type ShShell = Shell & {
  readonly runArgs: (
    script: string,
    args?: ReadonlyArray<string>,
  ) => ReadonlyArray<string>;
  readonly runCommand: (script: string) => ReadonlyArray<string>;
};

export class Shells extends Context.Service<
  Shells,
  {
    // The shell a project's command lines run in, to their end: setup,
    // teardown, port-pool, the console's scripts, custom launchers.
    readonly script: Effect.Effect<ShShell, NoScriptShell>;
    // The file it runs for a bare name, none when it has no such program.
    readonly findForScript: (
      name: string,
    ) => Effect.Effect<Option.Option<string>>;
    // The shell a terminal runs at its prompt, and `sm cd`'s subshell,
    // the syntax of what is typed into it (contracts' typedLines), and
    // whether it starts as a login shell.
    readonly interactive: Effect.Effect<
      Shell & { readonly syntax: ShellSyntax; readonly login: boolean }
    >;
    // Why the interactive shell can't be handed `program` with `args`
    // typed, so that one couldn't run a command, in words naming the
    // arguments `what`. None when it can.
    readonly untypable: (
      program: string,
      args: ReadonlyArray<string>,
      what: string,
    ) => Effect.Effect<Option.Option<string>>;
    // A POSIX sh, for the engine's own plumbing written in sh.
    readonly sh: Effect.Effect<ShShell, NoScriptShell>;
    // That sh running `script` with `args`, for a command line run to
    // its end with no terminal that may leave something running (a
    // lifecycle script, git running the person's hooks). Windows starts
    // it in a job (nativefs job), so ending the process started ends
    // all it started, Git Bash's orphans too, and its success leaves
    // what it left running. `env` keeps the arguments it hands a
    // program as they are.
    readonly containedSh: (
      script: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<
      {
        readonly program: string;
        readonly args: ReadonlyArray<string>;
        readonly env: Readonly<Record<string, string>>;
      },
      NoScriptShell
    >;
  }
>()("sm/engine/Shells") {}

// `nativefs` is the helper that holds a contained sh on Windows.
const make = (nativefs: string) =>
  Effect.gen(function* () {
    return Shells.of(
      yield* byFamily({
        posix: makeLogin,
        windows: makeWindows(nativefs),
      }),
    );
  });

export const layer = (nativefs: string) => Layer.effect(Shells, make(nativefs));
