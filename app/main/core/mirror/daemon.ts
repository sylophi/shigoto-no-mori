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
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { StreamChild } from "@host/fileSync/spawn";
import { errorMessageOf } from "@shigomori/contracts/errors";
import type { MirrorCreateInput } from "@host/ipc/modules/mirror";
import { lineSplitter } from "@host/lib/util/ndjson";
import {
  mirrorEngineBlocker,
  type MirrorDaemonStatus,
  type MirrorSessionRaw,
  MirrorSessionRawSchema,
} from "@shigomori/contracts/modules/mirror";
import { MIRROR_GATEWAY_TOKEN_ENV } from "./gateway";
import {
  BACKOFF_LADDER_MS,
  backoffDelayMs,
  STABLE_CONNECTION_MS,
} from "@shared/remote/supervisor";

// The lines the daemon writes (file-sync/engine.go, the daemon control
// protocol): an event, or a response echoing its request's id. Each is
// read against its schema, and one that breaks it is dropped and
// logged: the bridge keeps reading, the last state snapshot stands,
// and a request the line named is answered with the error. What a
// newer engine may add is let through: an event this build does not
// know is ignored, and a top-level key the schema does not name, on a
// line or on a session, is stripped. The nested shapes (endpoint,
// staging, conflict, problem, change) are the IPC contract's strict
// ones, so a field added inside them still drops the line.
const DaemonEventSchema = Schema.Union([
  Schema.Struct({ event: Schema.Literal("ready") }),
  Schema.Struct({
    event: Schema.Literal("state"),
    sessions: Schema.Array(MirrorSessionRawSchema),
  }),
  Schema.Struct({ event: Schema.Literal("error"), error: Schema.String }),
]);
type DaemonEvent = typeof DaemonEventSchema.Type;
const decodeDaemonEvent = Schema.decodeUnknownResult(DaemonEventSchema);
const KNOWN_EVENTS: ReadonlySet<string> = new Set(
  DaemonEventSchema.members.map((member) => member.fields.event.literal),
);

const DaemonResponseSchema = Schema.Struct({
  id: Schema.String,
  ok: Schema.Boolean,
  session: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
type DaemonResponse = typeof DaemonResponseSchema.Type;
const decodeDaemonResponse = Schema.decodeUnknownResult(DaemonResponseSchema);

type Pending = {
  resolve: (response: DaemonResponse) => void;
  reject: (error: Error) => void;
};

// Restart ladder after an unexpected exit: the house backoff plus a
// slow top rung, so a daemon that keeps dying (a broken build, a
// locked data directory) settles into a slow retry instead of a hot
// loop, while one that ran long enough to be healthy restarts from
// the bottom.
const RESTART_LADDER_MS: readonly [number, ...number[]] = [
  ...BACKOFF_LADDER_MS,
  30_000,
];
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
  let sessions: readonly MirrorSessionRaw[] = [];
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

  // The last rejection logged per kind of line (an event's name, or
  // "response"), so a daemon that keeps writing the same bad line
  // (every snapshot, once the contract has drifted) logs it once until
  // a line of that kind reads again. The requests in between do not
  // count.
  const lastRejection = new Map<string, string>();

  function handleLine(line: string): void {
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      log(`[mirror] daemon emitted a non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof doc !== "object" || doc === null) {
      rejectLine("other", line, "not an object");
      return;
    }
    if (
      "event" in doc &&
      typeof doc.event === "string" &&
      !KNOWN_EVENTS.has(doc.event)
    ) {
      return;
    }
    const kind = "event" in doc ? String(doc.event) : "response";
    const parsed: Result.Result<
      DaemonEvent | DaemonResponse,
      Schema.SchemaError
    > = "event" in doc ? decodeDaemonEvent(doc) : decodeDaemonResponse(doc);
    if (Result.isFailure(parsed)) {
      const reason = parsed.failure.message.replaceAll("\n", " ");
      rejectLine(kind, line, reason);
      // A request the line names is answered now, not at the timeout.
      if ("id" in doc && typeof doc.id === "string") {
        takePending(doc.id)?.reject(
          new Error("mirror daemon sent a malformed response"),
        );
      }
      return;
    }
    lastRejection.delete(kind);
    if ("event" in parsed.success) handleEvent(parsed.success);
    else handleResponse(parsed.success);
  }

  function rejectLine(kind: string, line: string, reason: string): void {
    if (lastRejection.get(kind) === reason) return;
    lastRejection.set(kind, reason);
    log(
      `[mirror] daemon line dropped, off the protocol: ${reason}: ${line.slice(0, 200)}`,
    );
  }

  // The request waiting on an id, taken off the list to be settled.
  function takePending(id: string): Pending | undefined {
    const entry = pending.get(id);
    pending.delete(id);
    return entry;
  }

  function handleEvent(event: DaemonEvent): void {
    switch (event.event) {
      case "ready":
        setStatus("running");
        return;
      case "state":
        sessions = event.sessions;
        deps.onChange?.();
        return;
      case "error":
        log(`[mirror] daemon error: ${event.error}`);
        return;
    }
  }

  function handleResponse(response: DaemonResponse): void {
    // mirrorResponse always writes its id, so a request the daemon
    // could not read comes back with an empty one. Nothing to match.
    if (response.id === "") {
      log(`[mirror] daemon refused a request: ${response.error ?? "unknown"}`);
      return;
    }
    takePending(response.id)?.resolve(response);
  }

  function spawnNow(): void {
    if (stopping) return;
    // The gateway binds on its own retry schedule. Until it has, the
    // daemon has nothing to dial and waits, which is not the engine
    // being missing.
    let gateway: string;
    try {
      gateway = deps.gatewayAddress();
    } catch (error) {
      log(`[mirror] daemon waiting for the gateway: ${errorMessageOf(error)}`);
      setStatus("starting");
      scheduleRestart();
      return;
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
      scheduleRestart();
      return;
    }
    child = spawned;
    const spawnedAt = Date.now();
    setStatus("starting");
    spawned.stream.on("data", lineSplitter(handleLine));
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
      if (Date.now() - spawnedAt >= STABLE_RUN_MS) restarts = 0;
      setStatus("starting");
      deps.onChange?.();
      scheduleRestart();
    });
  }

  function scheduleRestart(): void {
    if (stopping || restartTimer !== null) return;
    const delay = backoffDelayMs(RESTART_LADDER_MS, restarts);
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
          mirrorEngineBlocker(status) ??
            "The mirror daemon is not running yet.",
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
    if (!response.ok) {
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
