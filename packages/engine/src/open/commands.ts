// How Open runs a program, and opens what it names on this machine's
// screen.
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { byFamily } from "../platform.ts";
import { captureToFiles, exec } from "../processes.ts";
import * as Shells from "../Shells.ts";
import { NO_SCREEN, screenOpener } from "../screen.ts";
import { LaunchFailed } from "./documents.ts";

export const makeCommands = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const shells = yield* Shells.Shells;

  // Runs a program to its exit: its exit code, and what it printed.
  const ran = (program: string, args: ReadonlyArray<string>) =>
    exec(program, args, { all: true, anyExit: true }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.map(({ code, stdout }) => ({ code, output: stdout.trim() })),
      Effect.catch(({ cause }) =>
        Effect.succeed({ code: -1, output: errorMessageOf(cause) }),
      ),
    );

  // An app's command line tool run to its exit, by its exit code. The
  // app it starts keeps running, even as the tool's own child (Unity's
  // starts it that way). On POSIX that takes the tool's output in files,
  // since `exec` ends what a program leaves in its process group.
  const launched = (program: string, args: ReadonlyArray<string>) =>
    byFamily({
      posix: captureToFiles(spawner, program, args, { all: true }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Shells.Shells, shells),
        Effect.map(({ code }) => code),
        Effect.orElseSucceed(() => -1),
      ),
      windows: Effect.map(ran(program, args), ({ code }) => code),
    });

  // `open` and the like: done once it exits 0.
  const run = (label: string, program: string, args: ReadonlyArray<string>) =>
    Effect.flatMap(ran(program, args), ({ code, output }) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new LaunchFailed({
              label,
              said: code === -1 ? output : `exit status ${code}`,
            }),
          ),
    );

  // What `args` name, opened on this machine's screen.
  const onScreen = (label: string, args: ReadonlyArray<string>) =>
    Effect.flatMap(
      screenOpener,
      Option.match({
        onNone: () => Effect.fail(new LaunchFailed({ label, said: NO_SCREEN })),
        onSome: (opener) =>
          run(label, opener.program, [...opener.args, ...args]),
      }),
    );

  return { ran, launched, run, onScreen };
});

export type CommandsArea = Effect.Success<typeof makeCommands>;
