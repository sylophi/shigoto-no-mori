// The host's one way to run the file-sync engine (file-sync/, the
// continuous worktree mirror). Two roles are spawned through here: the
// long-lived `daemon` behind main/mirror/daemon.ts and one `serve`
// child per stream a peer opens (host/ipc/modules/forward.ts). Both
// are spoken to as a byte stream over stdin/stdout, never as document
// runs, so this seam is separate from the CLI delegate on purpose: the
// engine is not the CLI, nobody types its commands, and only this
// process ever starts it.
//
// Electron-free: main/electron/fileSyncRunner.ts injects the binary
// path and the quit-time child registration, the checks inject a
// freshly built binary.
import { type ChildProcess, spawn } from "node:child_process";
import { Duplex, type Readable, type Writable } from "node:stream";
import { signalTreeBestEffort } from "@host/lib/scripts/process";

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
// (signalTreeBestEffort) reaches anything it spawned in turn; onSpawned
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
  // A spawn failure surfaces as 'error' then 'close'; listening keeps
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
type FileSyncSpawnImpl = (args: string[]) => StreamChild | null;

let impl: FileSyncSpawnImpl | null = null;

export function setFileSyncSpawnImpl(next: FileSyncSpawnImpl): void {
  impl = next;
}

export function spawnFileSync(args: string[]): StreamChild | null {
  if (impl === null) {
    throw new Error("file-sync spawned before setFileSyncSpawnImpl ran");
  }
  return impl(args);
}
