// The host's one way to run the file-sync engine (file-sync/, the
// continuous worktree mirror). Two roles are spawned through here: the
// long-lived `daemon` behind host/mirror/daemon.ts and one `serve`
// child per stream a peer opens (host/ipc/modules/mirror.ts). Both
// are spoken to as a byte stream over stdin/stdout, never as document
// runs: nobody types the engine's commands, and only this process ever
// starts it.
//
// Every child runs in its own process group, in a scope under this
// service's.
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Duplex, PassThrough, type Readable } from "node:stream";

// No engine binary here (a dev run before `pnpm file-sync:build`).
export class FileSyncUnavailableError extends Schema.TaggedError<FileSyncUnavailableError>()(
  "FileSyncUnavailableError",
  {},
) {
  override get message(): string {
    return "mirroring is unavailable on this device (no file-sync engine)";
  }
}

export const isFileSyncUnavailable = Schema.is(FileSyncUnavailableError);

// A `serve` child: its stdin and stdout as one duplex stream, stderr
// apart for diagnostics.
export interface ServeChild {
  readonly pid: number;
  readonly stream: Duplex;
  readonly stderr: Readable;
}

// `env` is added to the app's environment.
export interface SpawnOptions {
  readonly env: Record<string, string | undefined>;
  readonly stdin: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
}

export class FileSync extends Context.Service<
  FileSync,
  {
    // A child in the caller's scope.
    readonly spawn: (
      args: readonly string[],
      options: SpawnOptions,
    ) => Effect.Effect<
      ChildProcessSpawner.ChildProcessHandle,
      FileSyncUnavailableError | PlatformError.PlatformError,
      Scope.Scope
    >;
    // A `serve` child in a scope of its own under the service's, ended
    // when `until` completes.
    readonly serve: (
      env: Record<string, string | undefined>,
      until: Effect.Effect<void>,
    ) => Effect.Effect<
      ServeChild,
      FileSyncUnavailableError | PlatformError.PlatformError
    >;
  }
>()("sm/host/FileSync") {}

const make = (binaryPath: () => string | null) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Effect.scope;

    const spawn = Effect.fn("FileSync.spawn")(function* (
      args: readonly string[],
      options: SpawnOptions,
    ) {
      const binary = binaryPath();
      if (binary === null) return yield* new FileSyncUnavailableError();
      return yield* spawner.spawn(
        ChildProcess.make(binary, [...args], {
          env: options.env,
          extendEnv: true,
          stdin: options.stdin,
          // The daemon halts its sessions on SIGTERM. One that hangs at
          // it must not hold the quit.
          forceKillAfter: "2 seconds",
        }),
      );
    });

    const serve = Effect.fn("FileSync.serve")(function* (
      env: Record<string, string | undefined>,
      until: Effect.Effect<void>,
    ) {
      const child = yield* Scope.fork(scope);
      const close = Scope.close(child, Exit.void);
      const input = new PassThrough();
      const handle = yield* spawn(["serve"], {
        env,
        stdin: NodeStream.fromReadable({
          evaluate: () => input,
          onError: (cause) =>
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSync",
              method: "serve",
              cause,
            }),
        }),
      }).pipe(
        Scope.provide(child),
        Effect.onError(() => close),
      );
      const output = yield* NodeStream.toReadable(handle.stdout);
      const stderr = yield* NodeStream.toReadable(handle.stderr);
      yield* until.pipe(Effect.andThen(close), Effect.forkIn(scope));
      return {
        pid: handle.pid,
        stream: Duplex.from({ readable: output, writable: input }),
        stderr,
      };
    });

    return FileSync.of({ spawn, serve });
  });

export const layer = (binaryPath: () => string | null) =>
  Layer.effect(FileSync, make(binaryPath));

// For the callers that are not Effect yet.
