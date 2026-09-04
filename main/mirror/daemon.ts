// Supervises this device's `file-sync daemon` (file-sync/engine.go): the
// long-lived Mutagen session manager behind continuous worktree
// mirroring. One child for the app's whole life, spoken to over its
// stdin/stdout in NDJSON: requests carry an id the response echoes,
// and the daemon streams a full state snapshot every time any session
// moves. The child dies when its stdin closes, so stopping is closing
// the pipe, and a crash is met with a restart on a short ladder
// (persisted sessions come back on their own when it does). The
// engine never outlives this process: besides the pipe, it exits on
// the quit-time SIGTERM and on seeing its parent pid change
// (file-sync/main.go, watchParent), so a host that dies uncleanly
// takes its daemon and every serve child down with it.
//
// Electron-free on purpose: the spawn is injected (main/electron owns
// the binary path and the quit-time reaping), so the mirror check
// drives this exact supervisor against a freshly built engine.
import type { StreamChild } from "@host/fileSync/spawn";
import { errorMessageOf } from "@shared/errors";
import type { MirrorSessionRaw } from "@host/ipc/modules/mirror";

export type MirrorDaemonStatus =
  | "stopped"
  | "starting"
  | "running"
  | "unavailable";

export type MirrorCreateRequest = {
  localRoot: string;
  deviceId: string;
  projectId: string;
  worktreeId: string;
  remoteRoot: string;
  name: string;
  labels: Record<string, string>;
  ignores?: string[];
};

type DaemonResponse = {
  id?: string;
  ok?: boolean;
  session?: string;
  error?: string;
  event?: string;
  sessions?: unknown[];
};

type Pending = {
  resolve: (response: DaemonResponse) => void;
  reject: (error: Error) => void;
};

// Restart ladder after an unexpected exit, capped. A daemon that keeps
// dying (a broken build, a locked data directory) settles into a slow
// retry instead of a hot loop.
const RESTART_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];
// A create blocks on two endpoint connects (the peer side spawns a
// process and Mutagen handshakes), so requests get a generous ceiling.
const REQUEST_TIMEOUT_MS = 120_000;

export type MirrorDaemon = ReturnType<typeof createMirrorDaemon>;

export function createMirrorDaemon(deps: {
  // Spawns `file-sync daemon ...` with the given args, or returns null
  // when no engine binary is available (a dev run before
  // file-sync:build), in which case the daemon reports "unavailable"
  // and retries later.
  spawn: (args: string[]) => StreamChild | null;
  // The gateway address the daemon dials peers through, read at each
  // spawn so a gateway rebound after a restart is picked up.
  gatewayAddress: () => string;
  // Where the engine persists sessions (a directory under the host's
  // state root), read at each spawn.
  dataDir: () => string;
  // Fires on every state snapshot and every status transition.
  onChange?: () => void;
  log?: (message: string) => void;
}) {
  let child: StreamChild | null = null;
  let status: MirrorDaemonStatus = "stopped";
  let sessions: MirrorSessionRaw[] = [];
  let stopping = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restarts = 0;
  let nextRequestId = 1;
  const pending = new Map<string, Pending>();
  const log = deps.log ?? ((message: string) => console.warn(message));

  function setStatus(next: MirrorDaemonStatus): void {
    if (status === next) return;
    status = next;
    deps.onChange?.();
  }

  function rejectAllPending(reason: string): void {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error(reason));
    }
  }

  function handleLine(line: string): void {
    let doc: DaemonResponse;
    try {
      doc = JSON.parse(line) as DaemonResponse;
    } catch {
      log(`[mirror] daemon emitted a non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    if (doc.event === "ready") {
      restarts = 0;
      setStatus("running");
      return;
    }
    if (doc.event === "state") {
      sessions = Array.isArray(doc.sessions)
        ? (doc.sessions as MirrorSessionRaw[])
        : [];
      deps.onChange?.();
      return;
    }
    if (doc.event === "error") {
      log(`[mirror] daemon error: ${doc.error ?? "unknown"}`);
      return;
    }
    if (typeof doc.id === "string") {
      const entry = pending.get(doc.id);
      if (entry === undefined) return;
      pending.delete(doc.id);
      entry.resolve(doc);
      return;
    }
    // A malformed-request response carries no id; nothing to match.
    if (doc.ok === false)
      log(`[mirror] daemon refused a request: ${doc.error}`);
  }

  function spawnNow(): void {
    if (stopping) return;
    let spawned: StreamChild | null;
    try {
      spawned = deps.spawn([
        "daemon",
        "--gateway",
        deps.gatewayAddress(),
        "--data-dir",
        deps.dataDir(),
      ]);
    } catch (error) {
      log(`[mirror] daemon spawn failed: ${errorMessageOf(error)}`);
      spawned = null;
    }
    if (spawned === null) {
      setStatus("unavailable");
      scheduleRestart();
      return;
    }
    child = spawned;
    setStatus("starting");
    let buffer = "";
    spawned.stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (
        let newline = buffer.indexOf("\n");
        newline >= 0;
        newline = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") handleLine(line);
      }
    });
    spawned.stream.on("error", () => {});
    spawned.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text !== "") log(`[mirror] daemon: ${text}`);
    });
    spawned.onExit((code) => {
      if (child !== spawned) return;
      child = null;
      sessions = [];
      rejectAllPending("mirror daemon exited");
      if (stopping) {
        setStatus("stopped");
        return;
      }
      log(`[mirror] daemon exited unexpectedly (code ${code}), restarting`);
      setStatus("starting");
      deps.onChange?.();
      scheduleRestart();
    });
  }

  function scheduleRestart(): void {
    if (stopping || restartTimer !== null) return;
    const delay =
      RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)] ??
      30_000;
    restarts++;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnNow();
    }, delay);
    restartTimer.unref?.();
  }

  function start(): void {
    stopping = false;
    if (child !== null || restartTimer !== null) return;
    spawnNow();
  }

  // Closes the control pipe (the daemon's exit signal) and, as a
  // backstop, kills a child that ignores it. Idempotent.
  function stop(): void {
    stopping = true;
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const current = child;
    child = null;
    sessions = [];
    rejectAllPending("mirror daemon stopped");
    if (current !== null) {
      current.stream.end();
      const killer = setTimeout(() => current.kill(), 2_000);
      killer.unref?.();
      current.onExit(() => clearTimeout(killer));
    }
    setStatus("stopped");
  }

  function request(
    op: string,
    fields: Record<string, unknown>,
  ): Promise<DaemonResponse> {
    const current = child;
    if (current === null || status !== "running") {
      return Promise.reject(
        new Error(
          status === "unavailable"
            ? "Mirroring is unavailable: the file-sync engine is missing."
            : "The mirror daemon is not running yet.",
        ),
      );
    }
    const id = String(nextRequestId++);
    return new Promise<DaemonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`mirror ${op} timed out`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      current.stream.write(JSON.stringify({ id, op, ...fields }) + "\n");
    });
  }

  async function expectOk(
    op: string,
    fields: Record<string, unknown>,
  ): Promise<string> {
    const response = await request(op, fields);
    if (response.ok !== true) {
      throw new Error(response.error ?? `mirror ${op} failed`);
    }
    return response.session ?? "";
  }

  return {
    start,
    stop,
    status: () => status,
    sessions: () => sessions,
    create: (input: MirrorCreateRequest) => expectOk("create", { ...input }),
    terminate: (session: string) => expectOk("terminate", { session }),
    pause: (session: string) => expectOk("pause", { session }),
    resume: (session: string) => expectOk("resume", { session }),
    flush: (session: string) => expectOk("flush", { session }),
  };
}
