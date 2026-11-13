// The lifecycle scripts a worktree runs as it is made and removed: the
// project's setup and teardown, and port-pool's provision and release.
// Each runs to its end in the script shell (Shells.ts), in the
// worktree, with the SHIGOMORI_* variables (packages/contracts
// scriptEnv) and the unattended-run settings, and every step is
// reported as the document `sm --json` prints for it, so the terminal
// and the host relay the same events.
import { scriptEnvOf, UNATTENDED_ENV } from "@shigomori/contracts/scriptEnv";
import {
  lifecycleScriptName,
  type LifecycleSlot,
  type ScriptEvent,
} from "@shigomori/contracts/schemas/scripts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { fileUntilExit } from "./processes.ts";
import * as Paths from "./Paths.ts";
import * as Shells from "./Shells.ts";
import { scriptOutputDir, scriptOutputPath } from "./scriptOutput.ts";

// Where a lifecycle step stands, as `sm --json` reports it.
export type Phase = "carryOver" | "setup" | "portPoolProvision" | "idle";

// One event of a lifecycle run, as the document `sm --json` prints.
export type LifecycleEvent =
  | { readonly event: "phase"; readonly phase: Phase }
  | ({ readonly event: "script" } & ScriptEvent);

type Report = (event: LifecycleEvent) => Effect.Effect<void>;

// A script that didn't finish cleanly: its step and exit code, null
// when it never ran or died to a signal.
export type ScriptFailure = {
  readonly step: string;
  readonly exitCode: number | null;
};

// What a script is told about the worktree it runs in.
export type ScriptContext = {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly path: string;
  };
  readonly worktree: {
    readonly id: string;
    readonly name: string;
    readonly branch: string;
    readonly path: string;
    readonly isExternal: boolean;
  };
  // The primary checkout's branch, empty for a bare repo.
  readonly projectBranch: string;
  // The project's primary ref.
  readonly defaultBranch: string;
  // What `sm describe` set, as stored.
  readonly title: string;
  readonly description: string;
};

// One script to run in a worktree. `color` asks for truecolor output,
// for a run the app's console shows.
type RunInput = {
  readonly command: string;
  readonly slot: LifecycleSlot;
  readonly context: ScriptContext;
  readonly color: boolean;
  readonly report: Report;
};

export class Lifecycle extends Context.Service<
  Lifecycle,
  {
    // Runs one script to its end, reporting it, and answers its exit
    // code (null when it never ran or died to a signal) and its run id.
    readonly run: (input: RunInput) => Effect.Effect<{
      readonly code: number | null;
      readonly runId: string;
    }>;
  }
>()("sm/engine/Lifecycle") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Paths.Paths;
  const shells = yield* Shells.Shells;

  const run = Effect.fn("Lifecycle.run")(function* (input: RunInput) {
    const { context, slot, report } = input;
    const runId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const script = (event: ScriptEvent) =>
      report({ event: "script", ...event } as LifecycleEvent);
    const started = (pid?: number) =>
      script({
        runId,
        kind: "started",
        projectId: context.project.id,
        worktreeId: context.worktree.id,
        slot,
        ...(pid === undefined ? {} : { pid, command: input.command }),
      });
    const exit = (code: number | null) =>
      script({ runId, kind: "exit", code }).pipe(Effect.as({ code, runId }));
    // The run's output goes to a file, the worktree's last of this
    // script, not to pipes: a child the script leaves in the background
    // keeps writing there, findable after, and holds nothing of this
    // process's (the terminal's `sm` waited on its pipes for good).
    const output = scriptOutputPath(
      paths.dataDir,
      context.worktree.id,
      lifecycleScriptName(slot),
    );
    const spawned = Effect.gen(function* () {
      const { program, args, env: shellEnv } = yield* shells.script;
      yield* fs.makeDirectory(
        scriptOutputDir(paths.dataDir, context.worktree.id),
        { recursive: true },
      );
      // A new file, not the last one emptied: a child an earlier run
      // left writes on into its own.
      yield* fs.remove(output, { force: true });
      yield* fs.writeFileString(output, "");
      return yield* spawner.spawn(
        // A POSIX shell opens the file and becomes the script shell
        // with it as stdout and stderr, whatever shell that is.
        ChildProcess.make(
          yield* shells.sh,
          Shells.shArgs('exec "$@" >>"$0" 2>&1', [
            output,
            program,
            ...args,
            "-c",
            input.command,
          ]),
          {
            cwd: context.worktree.path,
            // In this process's group, as a terminal runs it: Ctrl-C
            // reaches the whole tree, and what the script leaves running
            // in the background (a dev database) outlives it.
            detached: false,
            extendEnv: true,
            env: {
              ...shellEnv,
              ...scriptEnvOf(context, lifecycleScriptName(slot)),
              ...UNATTENDED_ENV,
              COLUMNS: "120",
              ...(input.color ? { COLORTERM: "truecolor" } : {}),
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      );
    }).pipe(Effect.result);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawned;
        if (Result.isFailure(handle)) {
          yield* started();
          yield* script({
            runId,
            kind: "error",
            data: errorMessageOf(handle.failure),
          });
          return yield* exit(null);
        }
        // Started before any output is read, so it comes first.
        yield* started(handle.success.pid);
        // One decoder for the run, so a character split across two reads
        // comes out whole.
        const decoder = new TextDecoder();
        // A signal death is no exit code, like a run that never started.
        const exitCode = handle.success.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => null),
        );
        // The shell's exit ends the run.
        const code = yield* fileUntilExit(output, exitCode, (chunk) =>
          script({
            runId,
            kind: "data",
            data: decoder.decode(chunk, { stream: true }),
          }),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.catch((error) =>
            script({ runId, kind: "error", data: errorMessageOf(error) }).pipe(
              Effect.andThen(exitCode),
            ),
          ),
        );
        const rest = decoder.decode();
        if (rest !== "") yield* script({ runId, kind: "data", data: rest });
        return yield* exit(code);
      }),
    );
  });

  return Lifecycle.of({ run });
});

export const layer = Layer.effect(Lifecycle, make);
