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
// The restart loop is one Effect fiber: spawn, wait for the child to
// exit, sleep one rung of the ladder, spawn again. stop() ends the
// child's pipe and interrupts the fiber, so there is no restart timer
// to clear and no stopping flag to check after each step.
//
// Electron-free on purpose: the spawn is injected (main/electron owns
// the binary path and the quit-time reaping), so the mirror check
// drives this exact supervisor against a freshly built engine.
import { Clock, Deferred, Effect, Fiber } from "effect";
import type { StreamChild } from "@host/fileSync/spawn";
import { errorMessageOf } from "@shared/errors";
import { containedSync } from "@shared/util/contained";
import type {
  MirrorCreateInput,
  MirrorSessionRaw,
} from "@host/ipc/modules/mirror";
import { lineSplitter } from "@host/lib/util/ndjson";
import { MIRROR_GATEWAY_TOKEN_ENV } from "./gateway";
import {
  BACKOFF_LADDER_MS,
  ranAtLeast,
  STABLE_CONNECTION_MS,
  superviseLadder,
} from "@shared/remote/supervisor";

export type MirrorDaemonStatus =
  | "stopped"
  | "starting"
  | "running"
  | "unavailable";

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

// Restart ladder after an unexpected exit: the house backoff plus a
// slow top rung, so a daemon that keeps dying (a broken build, a
// locked data directory) settles into a slow retry instead of a hot
// loop, while one that ran long enough to be healthy restarts from
// the bottom.
const RESTART_LADDER_MS: readonly number[] = [...BACKOFF_LADDER_MS, 30_000];
const STABLE_RUN_MS = STABLE_CONNECTION_MS;
// A create blocks on two endpoint connects (the peer side spawns a
// process and Mutagen handshakes), so requests get a generous ceiling.
const REQUEST_TIMEOUT_MS = 120_000;

export function createMirrorDaemon(deps: {
  // Spawns `file-sync daemon ...` with the given args, or returns null
  // when no engine binary is available (a dev run before
  // file-sync:build), in which case the daemon reports "unavailable"
  // and retries later.
  spawn: (args: string[], env?: NodeJS.ProcessEnv) => StreamChild | null;
  // The gateway address the daemon dials peers through, read at each
  // spawn (throwing when the gateway is not listening yet, which puts
  // the daemon on the restart ladder until it is).
  gatewayAddress: () => string;
  // The gateway's per-bind token, passed through the environment and
  // read at each spawn, so a rebound gateway's daemon carries the
  // token that gateway accepts.
  gatewayToken: () => string;
  // Where the engine persists sessions (a directory under the host's
  // data dir), read at each spawn.
  dataDir: () => string;
  // Fires on every state snapshot and every status transition.
  onChange?: () => void;
  log?: (message: string) => void;
}) {
  let child: StreamChild | null = null;
  let status: MirrorDaemonStatus = "stopped";
  let sessions: MirrorSessionRaw[] = [];
  let loop: Fiber.Fiber<void> | null = null;
  let nextRequestId = 1;
  const pending = new Map<string, Pending>();
  const log = deps.log ?? ((message: string) => console.warn(message));

  // The owner's onChange runs inside the loop's fiber and from the
  // child's stream callbacks; a throw from it must not end the loop
  // (a defect nothing reports) or the child's reader.
  function notifyChange(): void {
    containedSync("[mirror] onChange threw", () => deps.onChange?.(), log);
  }

  function setStatus(next: MirrorDaemonStatus): void {
    if (status === next) return;
    status = next;
    notifyChange();
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
      setStatus("running");
      return;
    }
    if (doc.event === "state") {
      sessions = Array.isArray(doc.sessions)
        ? (doc.sessions as MirrorSessionRaw[])
        : [];
      notifyChange();
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
    // A malformed-request response carries no id. Nothing to match.
    if (doc.ok === false)
      log(`[mirror] daemon refused a request: ${doc.error}`);
  }

  // One run of the child, from spawn to exit. Resolves to whether the
  // run was long enough to count as healthy, which restarts the ladder
  // from the bottom. A spawn that cannot happen yet (no gateway, no
  // binary) is a short run that keeps climbing.
  const runOnce: Effect.Effect<{ stable: boolean }> = Effect.gen(function* () {
    // The gateway binds on its own retry schedule. Until it has, the
    // daemon has nothing to dial and waits, which is not the engine
    // being missing.
    let gateway: string;
    try {
      gateway = deps.gatewayAddress();
    } catch (error) {
      log(`[mirror] daemon waiting for the gateway: ${errorMessageOf(error)}`);
      setStatus("starting");
      return { stable: false };
    }
    let spawned: StreamChild | null;
    try {
      spawned = deps.spawn(
        ["daemon", "--gateway", gateway, "--data-dir", deps.dataDir()],
        {
          ...process.env,
          [MIRROR_GATEWAY_TOKEN_ENV]: deps.gatewayToken(),
        },
      );
    } catch (error) {
      log(`[mirror] daemon spawn failed: ${errorMessageOf(error)}`);
      spawned = null;
    }
    if (spawned === null) {
      setStatus("unavailable");
      return { stable: false };
    }
    child = spawned;
    const spawnedAt = yield* Clock.currentTimeMillis;
    setStatus("starting");
    spawned.stream.on("data", lineSplitter(handleLine));
    spawned.stream.on("error", () => {});
    spawned.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text !== "") log(`[mirror] daemon: ${text}`);
    });
    // Completed by the child's exit. A child stop() already let go of
    // (child cleared first) completes nothing: its loop is interrupted.
    const exited = Deferred.makeUnsafe<number | null>();
    spawned.onExit((code) => {
      if (child !== spawned) return;
      child = null;
      sessions = [];
      rejectAllPending("mirror daemon exited");
      Deferred.doneUnsafe(exited, Effect.succeed(code));
    });
    const code = yield* Deferred.await(exited);
    log(`[mirror] daemon exited unexpectedly (code ${code}), restarting`);
    const stable = yield* ranAtLeast(spawnedAt, STABLE_RUN_MS);
    setStatus("starting");
    notifyChange();
    return { stable };
  });

  function start(): void {
    if (loop !== null) return;
    loop = Effect.runFork(superviseLadder(RESTART_LADDER_MS, runOnce));
  }

  // Closes the control pipe (the daemon's exit signal) and, as a
  // backstop, kills a child that ignores it. Synchronous on purpose:
  // the quit path calls it and moves on, so the pipe closes now and
  // only the loop's interruption is deferred. Idempotent.
  function stop(): void {
    const running = loop;
    loop = null;
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
    if (running !== null) Effect.runFork(Fiber.interrupt(running));
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
    create: (input: MirrorCreateInput) => expectOk("create", { ...input }),
    terminate: (session: string) => expectOk("terminate", { session }),
    pause: (session: string) => expectOk("pause", { session }),
    resume: (session: string) => expectOk("resume", { session }),
  };
}
