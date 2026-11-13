// Which shell runs what: a project's command lines, and a terminal's
// prompt. Each OS picks its own (shells/).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { byPlatform } from "./platform.ts";
import { makeLogin } from "./shells/login.ts";

// A shell as started: the program, and what it starts with before
// anything else (`-l` for a login shell).
export type Shell = {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
};

export class Shells extends Context.Service<
  Shells,
  {
    // The shell a project's command lines run in, to their end: setup,
    // teardown, port-pool, the console's scripts, custom launchers. It
    // reads POSIX sh syntax and takes a command line after `-c`.
    readonly script: Effect.Effect<Shell>;
    // The shell a terminal runs at its prompt, and `sm cd`'s subshell.
    readonly interactive: Effect.Effect<Shell>;
  }
>()("sm/engine/Shells") {}

const make = Effect.gen(function* () {
  return Shells.of(yield* byPlatform({ darwin: makeLogin, linux: makeLogin }));
});

export const layer = Layer.effect(Shells, make);
