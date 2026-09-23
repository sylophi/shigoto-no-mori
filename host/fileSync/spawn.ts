// The host's one way to run the file-sync engine (file-sync/, the
// continuous worktree mirror). Two roles are spawned through here: the
// long-lived `daemon` behind main/core/mirror/daemon.ts and one `serve`
// child per stream a peer opens (host/ipc/modules/forward.ts). Both
// are spoken to as a byte stream over stdin/stdout, never as document
// runs, so this seam is separate from the CLI delegate on purpose: the
// engine is not the CLI, nobody types its commands, and only this
// process ever starts it.
//
// Electron-free: main/electron/fileSyncRunner.ts provides the binary
// path and the quit-time child registration, the checks provide a
// freshly built binary.
import { type ChildProcess, spawn } from "node:child_process";
import { Duplex, type Readable, type Writable } from "node:stream";
import { Context } from "effect";
import { signalTreeBestEffort } from "@host/lib/scripts/process";
import { hostService } from "@host/runtime";

// A child whose stdin/stdout are one duplex stream. stderr stays
// separate for diagnostics.
export interface StreamChild {
  stream: Duplex;
  stderr: Readable | null;
  pid: number | undefined;
  kill: () => void;
  onExit: (listener: (code: number | null) => void) => void;
}

// Spawns any binary as a stream child. `detached` puts it in its own
// process group, like the CLI runner, so the quit-time reap
// (signalTreeBestEffort) reaches anything it spawned in turn. The onSpawned
// is the registration hook for that reap.
export function spawnStreamChild(
  binary: string,
  args: string[],
  opts: {
    onSpawned?: (child: ChildProcess) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): StreamChild {
  const child = spawn(binary, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: opts.env ?? process.env,
  });
  opts.onSpawned?.(child);
  const stream = Duplex.from({
    readable: child.stdout as Readable,
    writable: child.stdin as Writable,
  });
  // A spawn failure surfaces as 'error' then 'close'. Listening keeps
  // node from treating it as an uncaught exception, and onExit
  // consumers see the close.
  child.on("error", () => {});
  return {
    stream,
    stderr: child.stderr,
    pid: child.pid,
    kill: () => {
      try {
        if (child.pid !== undefined) signalTreeBestEffort(child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    },
    onExit: (listener) => {
      child.once("close", (code) => listener(code));
    },
  };
}

// Returns null when no engine binary is available (a dev run before
// `pnpm file-sync:build`), so callers degrade to "unavailable" rather
// than throwing at boot.
type FileSyncSpawnImpl = (
  args: string[],
  env?: NodeJS.ProcessEnv,
) => StreamChild | null;

export class FileSyncSpawn extends Context.Service<
  FileSyncSpawn,
  FileSyncSpawnImpl
>()("sm/host/FileSyncSpawn") {}

export function spawnFileSync(
  args: string[],
  env?: NodeJS.ProcessEnv,
): StreamChild | null {
  return hostService(
    FileSyncSpawn,
    "file-sync spawned before the host runtime provided FileSyncSpawn",
  )(args, env);
}
