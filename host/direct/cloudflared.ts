// The cloudflared runtime for tunnel endpoints (v2 step 10, slice B):
// discover the binary, ask the relay Worker to provision this device's
// named tunnel against the direct listener's current loopback port,
// and supervise `cloudflared tunnel run` as a child process. The
// tunnel fronts 127.0.0.1 only (the ingress the Worker writes pins
// that), and the connector token is a bearer secret: it lives in
// memory, reaches the child via env (TUNNEL_TOKEN), never argv, and
// never appears in logs or status objects.
//
// Supervision follows the repo's existing discipline rather than new
// machinery: the backoff ladder, its lookup and the stable-reset rule
// come straight from shared/remote/supervisor.ts (whose clock seam
// this reuses), and the give-up-vs-retry split mirrors
// main/liveness/rateLimit.ts in being driven headlessly by the
// direct-plane check. Stop conditions are the caller's: main
// reconciles this runner alongside the direct listener, so sign-out,
// an account switch and the directConnections opt-out all land here as
// reconcile(null), while quit alone calls stop() (a terminal latch,
// see below).
//
// This file must stay Electron free (host:check). Node builtins are
// fine here.
import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { errorMessageOf } from "@shared/errors";
import {
  TunnelProvisionDeniedError,
  TunnelUnconfiguredError,
} from "@shared/account/service";
import type { TunnelState } from "@shared/ipc/modules/relay";
import {
  BACKOFF_LADDER_MS,
  backoffDelayMs,
  defaultSupervisorClock,
  STABLE_CONNECTION_MS,
  type SupervisorClock,
  type SupervisorTimer,
} from "@shared/remote/supervisor";
import { createLimiter } from "@shared/util/limit";
import { killWithGrace } from "@host/lib/scripts/process";
import { resolveOnPath } from "@host/lib/util/binaries";

const execFileP = promisify(execFile);

// ---- pure deciders, exported for the direct-plane check ----

// Restart delays for a failing tunnel (a provision error, a child that
// exits), capped at the last rung: the socket supervisor's ladder plus
// one extra top rung, so a persistently failing cloudflared never
// re-spawns more than once a minute. Looked up through the
// supervisor's shared backoffDelayMs.
export const TUNNEL_BACKOFF_LADDER_MS: readonly number[] = [
  ...BACKOFF_LADDER_MS,
  60_000,
];

// A child that stayed up at least this long before dying is treated as
// healthy, so its restart starts the ladder from the bottom: the same
// stable threshold the socket supervisor uses.
export const TUNNEL_STABLE_MS = STABLE_CONNECTION_MS;

// The readiness probe schedule: a fresh child is advertised only once
// its hostname actually ROUTES from the edge to the local listener
// (edge registration plus, for a first-ever tunnel, CNAME
// propagation). Attempts are spaced on this ladder (capped at the last
// rung) until the deadline, after which the child is treated exactly
// like one that died: killed and rescheduled on the backoff ladder. A
// child that merely survives a spawn says nothing about routability,
// and a web client whose ONLY candidate is the tunnel would burn its
// keeper's backoff rungs against a not-yet-routable advertisement (a
// transient failure, so it retries forever -- but each wasted rung
// pushes the next attempt further out).
export const TUNNEL_PROBE_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000,
];
export const TUNNEL_PROBE_DEADLINE_MS = 60_000;

// One probe attempt's own fetch bound, so a black-holed edge cannot
// wedge the probe chain.
const PROBE_ATTEMPT_TIMEOUT_MS = 5_000;

// The child's argv and env, pure so the check can pin the secret
// discipline: the connector token rides ONLY in env.TUNNEL_TOKEN
// (cloudflared reads it there), never argv, so `ps` output and spawn
// logging can never leak it.
export function cloudflaredArgs(): string[] {
  // --no-autoupdate: cloudflared otherwise checks for a newer release
  // and replaces its own binary, which would break the signature of
  // the copy the app ships. The version is pinned in
  // shared/cloudflaredDist.mts and bumped with the app.
  return ["tunnel", "--no-autoupdate", "run"];
}

export function cloudflaredEnv(
  base: NodeJS.ProcessEnv,
  connectorToken: string,
): NodeJS.ProcessEnv {
  return { ...base, TUNNEL_TOKEN: connectorToken };
}

// ---- binary discovery ----

// Resolution order: the configured override (a device-scoped config
// key, see cloudflaredPath in shared/schemas/config.ts), then the copy
// the app ships (the zero-install path, and the one a packaged build
// normally takes), then PATH for a build that carries none. Null means
// tunnels are off: the caller logs ONE clear line and reports the
// typed status, never an error loop.
export async function resolveCloudflaredBinary(
  configuredPath: string | undefined,
  bundledPath: string | null,
): Promise<string | null> {
  const configured = configuredPath?.trim() ?? "";
  if (configured !== "") {
    return (await runsAsCloudflared(configured)) ? configured : null;
  }
  if (bundledPath !== null && (await runsAsCloudflared(bundledPath))) {
    return bundledPath;
  }
  return resolveOnPath("cloudflared");
}

// `-x` semantics via the binary itself: asking cloudflared for its
// version proves the path exists AND is executable in one probe, where
// a bare stat would pass a stray non-executable. A path that exists
// but will not run (a lost executable bit, Gatekeeper refusing an
// unsigned copy, the wrong architecture) is the one case the user can
// act on and cannot otherwise see, so it is logged. A missing file is
// not: that is the ordinary "ships none" answer. The probe is bounded
// so a wedged binary cannot stall the runner's serialized lifecycle.
async function runsAsCloudflared(path: string): Promise<boolean> {
  try {
    await execFileP(path, ["--version"], { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      console.warn(
        `[tunnel] cloudflared at ${path} did not run: ${errorMessageOf(error)}`,
      );
    }
    return false;
  }
}

const PROBE_TIMEOUT_MS = 10_000;

// ---- the supervised runner ----

// The state vocabulary is the wire's (RelayStatusSchema.tunnel in
// shared/ipc/modules/relay.ts), imported rather than redeclared so the
// runner and the status surface cannot drift. off: not wanted
// (listener down, opted out, signed out). no-binary: wanted, but no
// usable cloudflared. unconfigured: the Worker has no tunnel env
// (typed answer, cached for the process lifetime). starting:
// provisioning, spawning, or probing readiness. up: the child is
// probed-routable and the tunnel is advertised. error: the last
// attempt failed, with either a backoff restart scheduled or (for a
// denied provision) nothing until the next reconcile trigger.
export type { TunnelState };

// The renderer-safe status snapshot: never the connector token.
// Operator detail for a failure goes to the log, not here.
export type TunnelStatus = {
  state: TunnelState;
  hostname: string | null;
};

export type TunnelChild = {
  // Registers the single exit observer. Must fire exactly once, on
  // exit or on a spawn failure.
  onExit(handler: (detail: string) => void): void;
  kill(): void;
  // The OS pid when the spawn produced one, for the orphan-reap
  // bookkeeping. Absent from test stubs.
  pid?: number;
};

export type CloudflaredRunnerDeps = {
  // Resolves the usable binary, null when absent.
  resolveBinary(): Promise<string | null>;
  // The relay Worker's provision call for the given listener port.
  // Throws TunnelUnconfiguredError when the Worker has no tunnel env,
  // TunnelProvisionDeniedError on any other 4xx refusal.
  provision(
    port: number,
  ): Promise<{ hostname: string; connectorToken: string }>;
  // Test seam. The default spawns the real cloudflared with the token
  // in env only.
  spawnTunnel?: (binaryPath: string, connectorToken: string) => TunnelChild;
  // One readiness probe attempt: true when the hostname routes from
  // the edge to the local listener. The default GETs the hostname over
  // HTTPS and reads any edge answer that the LISTENER produced (the
  // 426 a ws server earns for a non-upgrade GET) as routable.
  probeTunnel?: (hostname: string) => Promise<boolean>;
  // Where the live child's pid is recorded so a crashed Electron's
  // orphaned cloudflared can be reaped on the next launch. A getter
  // because the userData path is an app-ready fact. When absent
  // (tests), the bookkeeping is disabled.
  pidFilePath?: () => string;
  // Fired on every state transition so the owner can fan status out.
  onChange?: () => void;
  clock?: SupervisorClock;
};

export type CloudflaredRunner = {
  // Reconciles the runner with the wanted state: null stops (sign-out,
  // account switch, directConnections off, listener down), a port
  // (re)provisions and (re)starts the child. Serialized, so an
  // overlapping stop and start cannot interleave. Reconciling the SAME
  // port over a runner that is doing anything at all about it (child
  // up, retry scheduled, the cached unconfigured verdict) is a no-op,
  // so an unrelated config write can neither storm the Worker nor
  // reset a failing runner's backoff. Two states do re-enter:
  // no-binary (a config write may have just named a usable
  // cloudflaredPath) and a provision-denied park (the reconcile
  // trigger IS its recovery path: a re-sign-in or a Worker redeploy
  // arrives here).
  reconcile(wanted: { port: number } | null): Promise<void>;
  stop(): Promise<void>;
  status(): TunnelStatus;
  // The wss dial URL while the tunnel is healthy, else null. What the
  // direct broker advertises.
  tunnelUrl(): string | null;
};

// How long a SIGTERM'd child gets before SIGKILL. cloudflared closes
// its edge connections promptly, so this only bounds a wedged one.
const KILL_GRACE_MS = 3_000;

function spawnCloudflared(
  binaryPath: string,
  connectorToken: string,
): TunnelChild {
  const child = spawn(binaryPath, cloudflaredArgs(), {
    // The token rides ONLY in env, never argv.
    env: cloudflaredEnv(process.env, connectorToken),
    // Output is dropped: cloudflared logs verbosely, an unread pipe
    // would grow a buffer forever, and the exit code plus our own
    // status line carry everything supervision needs.
    stdio: ["ignore", "ignore", "ignore"],
  });
  let exited = false;
  let handler: ((detail: string) => void) | null = null;
  const fire = (detail: string): void => {
    if (exited) return;
    exited = true;
    handler?.(detail);
  };
  child.on("exit", (code, signal) => {
    fire(`cloudflared exited (${signal ?? `code ${code}`})`);
  });
  child.on("error", (error) => {
    fire(`cloudflared failed to spawn: ${errorMessageOf(error)}`);
  });
  return {
    onExit(next) {
      handler = next;
    },
    kill() {
      if (!exited) killWithGrace(child, KILL_GRACE_MS);
    },
    pid: child.pid,
  };
}

// The default readiness probe: a plain HTTPS GET of the tunnel
// hostname. The direct listener is a ws server, so a non-upgrade GET
// that actually REACHED it earns an HTTP 426 (or 400) relayed through
// the edge. A tunnel the edge cannot route yet answers 5xx (CF 530
// "no connector") or times out. Dependency-free on purpose: fetch is
// the platform global.
async function probeTunnelEdge(hostname: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${hostname}`, {
      signal: AbortSignal.timeout(PROBE_ATTEMPT_TIMEOUT_MS),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

// Kill a previous app instance's orphaned cloudflared, recorded in the
// pid file: nothing reaps the child when Electron dies without running
// before-quit (a crash, a SIGKILL), so the next launch does. The
// process NAME is verified before killing so a recycled pid never
// takes out an innocent process. Residual exposure, accepted: when the
// app is SIGKILLed and never launched again, the orphan connector
// keeps running until the machine reboots or the user kills it.
async function reapStaleChild(pidFilePath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(pidFilePath, "utf8");
  } catch {
    return;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  // The same pid floor as scripts/process.ts safeKill: never signal
  // groups, self, or launchd on a corrupt file.
  if (Number.isInteger(pid) && pid >= 2) {
    try {
      const { stdout } = await execFileP("ps", [
        "-p",
        String(pid),
        "-o",
        "comm=",
      ]);
      if (stdout.trim().toLowerCase().includes("cloudflared")) {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // No such process, or ps failed. Nothing to reap.
    }
  }
  await rm(pidFilePath, { force: true }).catch(() => {});
}

export function createCloudflaredRunner(
  deps: CloudflaredRunnerDeps,
): CloudflaredRunner {
  const clock = deps.clock ?? defaultSupervisorClock;
  const spawnTunnel = deps.spawnTunnel ?? spawnCloudflared;
  const probeTunnel = deps.probeTunnel ?? probeTunnelEdge;
  // Serializes reconcile/stop so a fast toggle cannot interleave one
  // reconcile's teardown with another's start, mirroring the ws
  // binding's lifecycle limiter. stopNow is the one mutator allowed to
  // run OUTSIDE the slot (the quit pre-empt below): it nulls
  // wantedPort and (from stop) sets the terminal `stopped` latch,
  // which every queued lifecycle task checks first, so neither a
  // parked start nor a reconcile QUEUED behind an in-flight provision
  // can spawn under a stopped runner.
  const lifecycle = createLimiter(1);

  let status: TunnelStatus = { state: "off", hostname: null };
  // The port the owner currently wants fronted, null when stopped.
  let wantedPort: number | null = null;
  // The terminal quit latch. stop() has exactly one caller, main's
  // before-quit path via stopDirectHost (config-off and account-off
  // arrive as reconcile(null) instead), so once set it never clears:
  // a task that drains from the lifecycle queue after quit began must
  // do nothing, whatever it was queued to do.
  let stopped = false;
  let child: TunnelChild | null = null;
  // When the live child was spawned, for the stable-reset rule.
  let spawnedAt = 0;
  // Ladder position for the current failure streak.
  let attempt = 0;
  let retryTimer: SupervisorTimer | null = null;
  let readyTimer: SupervisorTimer | null = null;
  // The last successful provision, held in memory only (the token is a
  // bearer secret: it goes into a child's env and never anywhere
  // observable), so a crash restart re-spawns without a Worker round
  // trip while the port is unchanged. Reuse requires the PREVIOUS
  // child to have reached probed readiness (lastChildReady below): a
  // child that died without ever becoming routable may be holding a
  // dead token, so its successor re-provisions. The cache dies with
  // stopNow.
  let lastProvision: {
    port: number;
    hostname: string;
    connectorToken: string;
  } | null = null;
  // Whether the most recently spawned child passed the readiness
  // probe. Reset on every spawn, so it always describes the child
  // whose crash a restart is recovering from.
  let lastChildReady = false;
  // The Worker answering "no tunnel env" is a deployment fact, cached
  // for the process lifetime: reconciles cannot change it, so they
  // must not keep paying the provision round trip to re-learn it.
  let workerUnconfigured = false;
  // Set when a provision was DENIED (4xx: revoked credential, older
  // Worker deploy). No retry timer runs. The next reconcile trigger
  // re-enters instead, because only changed inputs (a re-sign-in, a
  // redeploy) can change the answer.
  let provisionDenied = false;
  // A previous app instance's recorded child is reaped once per
  // process, before the first spawn.
  let stalePidReaped = false;

  function setStatus(next: TunnelStatus): void {
    const changed =
      next.state !== status.state || next.hostname !== status.hostname;
    status = next;
    if (changed) deps.onChange?.();
  }

  function clearTimers(): void {
    if (retryTimer !== null) {
      clock.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (readyTimer !== null) {
      clock.clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  function pidFilePathOf(): string | null {
    try {
      return deps.pidFilePath?.() ?? null;
    } catch {
      return null;
    }
  }

  function clearPidFile(): void {
    const path = pidFilePathOf();
    if (path !== null) {
      void rm(path, { force: true }).catch(() => {});
    }
  }

  function killChild(): void {
    if (child !== null) {
      const dying = child;
      child = null;
      dying.kill();
      clearPidFile();
    }
  }

  function scheduleRestart(detail: string): void {
    const delayMs = backoffDelayMs(TUNNEL_BACKOFF_LADDER_MS, attempt);
    attempt += 1;
    setStatus({ state: "error", hostname: null });
    console.warn(`[tunnel] ${detail}, retrying in ${delayMs}ms`);
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      // The port is read when the timer FIRES: a stop that beat the
      // timer nulled it, and the queued task must not re-read state
      // that may have moved on by the time the limiter drains.
      const port = wantedPort;
      if (port !== null && !stopped) {
        void lifecycle(() => startNow(port));
      }
    }, delayMs);
  }

  // The readiness probe chain for a freshly spawned child: attempts on
  // the probe ladder until routable or the deadline, then either
  // advertise or treat the child as failed. Deliberately NOT re-run
  // after "up": the child process exiting is the down signal, and a
  // liveness poll against the edge would spend a request per interval
  // to learn what the exit handler already tells us.
  function beginProbe(next: TunnelChild, port: number, hostname: string): void {
    const startedAt = clock.now();
    let probeAttempt = 0;
    const live = (): boolean =>
      !stopped && child === next && wantedPort === port;
    const finish = (routable: boolean): void => {
      if (!live()) return;
      if (routable) {
        lastChildReady = true;
        setStatus({ state: "up", hostname });
        console.info(`[tunnel] up at ${hostname}`);
        return;
      }
      if (clock.now() - startedAt >= TUNNEL_PROBE_DEADLINE_MS) {
        // Never became routable: the same failure path as a child
        // that died, and since it never reached readiness the restart
        // re-provisions rather than reusing its possibly-dead token.
        killChild();
        scheduleRestart(`tunnel at ${hostname} never became routable`);
        return;
      }
      scheduleNext();
    };
    const scheduleNext = (): void => {
      readyTimer = clock.setTimeout(
        () => {
          readyTimer = null;
          if (!live()) return;
          probeTunnel(hostname).then(finish, () => finish(false));
        },
        backoffDelayMs(TUNNEL_PROBE_DELAYS_MS, probeAttempt),
      );
      probeAttempt += 1;
    };
    scheduleNext();
  }

  // The body of one start attempt, running inside the lifecycle
  // limiter. Throws are caught and classified by startNow, so an
  // unexpected rejection (resolveBinary, the pid reap) lands on the
  // same retry-or-park rails as a provision failure instead of
  // unwinding through the caller as an unhandled rejection.
  async function startBody(port: number): Promise<void> {
    if (workerUnconfigured) {
      setStatus({ state: "unconfigured", hostname: null });
      return;
    }
    const binaryPath = await deps.resolveBinary();
    if (stopped || wantedPort !== port) return;
    if (binaryPath === null) {
      // Logged on the transition into no-binary only, not once per
      // reconcile.
      if (status.state !== "no-binary") {
        console.info(
          "[tunnel] no usable cloudflared (the cloudflaredPath config " +
            "key, the bundled copy, PATH), tunnel endpoints are off",
        );
      }
      setStatus({ state: "no-binary", hostname: null });
      return;
    }
    const pidFile = pidFilePathOf();
    if (pidFile !== null && !stalePidReaped) {
      stalePidReaped = true;
      await reapStaleChild(pidFile);
      if (stopped || wantedPort !== port) return;
    }
    const reusable =
      lastProvision !== null && lastProvision.port === port && lastChildReady;
    if (!reusable) {
      const provisioned = await deps.provision(port);
      if (stopped || wantedPort !== port) return;
      lastProvision = { port, ...provisioned };
    }
    const { hostname, connectorToken } = lastProvision!;
    const next = spawnTunnel(binaryPath, connectorToken);
    child = next;
    spawnedAt = clock.now();
    lastChildReady = false;
    setStatus({ state: "starting", hostname });
    if (pidFile !== null && next.pid !== undefined) {
      void writeFile(pidFile, `${next.pid}\n`, "utf8").catch(() => {});
    }
    next.onExit((detail) => {
      if (child !== next) return;
      child = null;
      clearPidFile();
      if (readyTimer !== null) {
        clock.clearTimeout(readyTimer);
        readyTimer = null;
      }
      if (stopped || wantedPort === null) return;
      // Stable-reset rule, inline like the socket supervisor's
      // scheduleBackoff: a child that held the tunnel past the stable
      // window broke the failure streak, anything shorter climbs the
      // ladder.
      if (clock.now() - spawnedAt >= TUNNEL_STABLE_MS) attempt = 0;
      scheduleRestart(detail);
    });
    beginProbe(next, port, hostname);
  }

  // One start attempt for the given port. Runs inside the lifecycle
  // limiter only. The stopped/wantedPort guards after each await cover
  // the pre-empting stop() and reconcile(null).
  async function startNow(port: number): Promise<void> {
    if (stopped || wantedPort !== port) return;
    clearTimers();
    // Downgrade BEFORE killing: from here to a successful probe the
    // connector is not serving, and "starting" (which reads as
    // tunnelUrl() null) must never advertise a dead child through the
    // binary/provision awaits below.
    setStatus({ state: "starting", hostname: null });
    killChild();
    provisionDenied = false;
    try {
      await startBody(port);
    } catch (error) {
      if (stopped || wantedPort !== port) return;
      if (error instanceof TunnelUnconfiguredError) {
        // A deployment fact, not a failure: cached so no later
        // reconcile retries it either.
        workerUnconfigured = true;
        setStatus({ state: "unconfigured", hostname: null });
        return;
      }
      if (error instanceof TunnelProvisionDeniedError) {
        // Refused outright (a revoked credential's 401, an older
        // Worker deploy's 404): a timed retry re-presents the same
        // request, so park with NO retry scheduled. The next
        // reconcile trigger re-enters, which is exactly when the
        // inputs can have changed.
        provisionDenied = true;
        setStatus({ state: "error", hostname: null });
        console.warn(
          `[tunnel] provisioning denied (${errorMessageOf(error)}), ` +
            "waiting for the next account or config change",
        );
        return;
      }
      scheduleRestart(`tunnel start failed: ${errorMessageOf(error)}`);
    }
  }

  // Synchronous and idempotent, so both the serialized reconcile(null)
  // path and the pre-empting stop() below may call it freely.
  function stopNow(): void {
    wantedPort = null;
    clearTimers();
    killChild();
    attempt = 0;
    provisionDenied = false;
    // The cached provision dies with the stop: a later start under a
    // possibly different account must never front stale credentials.
    lastProvision = null;
    lastChildReady = false;
    setStatus({ state: "off", hostname: null });
  }

  return {
    reconcile: (wanted) =>
      lifecycle(async () => {
        // The quit latch outranks everything a queued reconcile might
        // want: a reconcile that drained from the queue after stop()
        // must not respawn a child mid-quit.
        if (stopped) return;
        if (wanted === null) {
          stopNow();
          return;
        }
        // No-op whenever the port is unchanged and the runner is not
        // "off": a live child, a scheduled retry and the cached
        // unconfigured verdict are all already the right response to
        // this port, and re-entering startNow here is what used to
        // reset a failing runner's backoff to rung 0 on every
        // unrelated config write. Two states do re-enter: "no-binary"
        // (a config write may have just named a usable
        // cloudflaredPath, and re-resolving is a probe with no Worker
        // round trip and no ladder to disturb) and a provision-denied
        // park, whose ONLY recovery path is the next reconcile
        // trigger.
        if (
          wanted.port === wantedPort &&
          status.state !== "off" &&
          status.state !== "no-binary" &&
          !provisionDenied
        ) {
          return;
        }
        const portChanged = wanted.port !== wantedPort;
        wantedPort = wanted.port;
        // The failure streak belongs to the OLD port's attempts.
        if (portChanged) attempt = 0;
        await startNow(wanted.port);
      }),
    stop: () => {
      // Pre-empt, do not queue: quit must never park behind an
      // in-flight provision holding the limiter. The latch plus
      // stopNow mark stopped synchronously and kill the child, a
      // parked start's guards make it bail, and any reconcile still
      // QUEUED behind the in-flight slot sees the latch and does
      // nothing. The queued stopNow keeps the resolved promise
      // ordered after any in-flight slot, and is a no-op by
      // idempotence.
      stopped = true;
      stopNow();
      return lifecycle(async () => {
        stopNow();
      });
    },
    status: () => ({ ...status }),
    tunnelUrl: () =>
      status.state === "up" && status.hostname !== null
        ? `wss://${status.hostname}`
        : null,
  };
}
