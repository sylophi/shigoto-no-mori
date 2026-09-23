// The cloudflared runtime for tunnel endpoints:
// discover the binary, ask the hub Worker to provision this device's
// named tunnel against the direct listener's current loopback port,
// and supervise `cloudflared tunnel run` as a child process. The
// tunnel fronts 127.0.0.1 only (the ingress the Worker writes pins
// that), and the connector token is a bearer secret: it lives in
// memory, reaches the child via env (TUNNEL_TOKEN), never argv, and
// never appears in logs or status objects.
//
// Supervision follows the repo's existing discipline rather than new
// machinery: the backoff ladder, its lookup and the stable-reset rule
// come straight from shared/remote/supervisor.ts (whose runtime seam
// this reuses), and the give-up-vs-retry split mirrors
// main/core/liveness/rateLimit.ts in being driven headlessly by the
// direct-plane check. Stop conditions are the caller's: main
// reconciles this runner alongside the direct listener, so sign-out,
// an account switch and the directConnections opt-out all land here as
// reconcile(null), while quit alone calls stop() (terminal, see below).
//
// One Effect fiber per wanted port runs the whole lifecycle: provision,
// spawn, probe until routable, hold until the child exits, sleep one
// rung, again. The child is a scoped resource whose finalizer kills it
// and clears its pid file, so interrupting the fiber (a port change,
// reconcile(null), quit) is the whole teardown: a probe or a backoff
// sleep in flight is cancelled with it, and no continuation is left to
// ask whether its port is still wanted. Reconciles are serialized in
// call order (createLimiter). Every fiber, the reconciles' included, is
// forked into the runner's scope, and stop() closes that scope: what is
// in flight is interrupted, what is queued never runs, and a scope that
// is closed refuses every later fork, which is the quit latch.
//
// This file must stay Electron free (pnpm test host-boundary). Node
// builtins are fine here.
import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Scope,
} from "effect";
import { errorMessageOf } from "@shared/errors";
import {
  TunnelProvisionDeniedError,
  TunnelUnconfiguredError,
} from "@shared/account/service";
import type { TunnelState } from "@shared/ipc/modules/hub";
import {
  TUNNEL_PROBE_DEADLINE_FRESH_MS,
  BACKOFF_LADDER_MS,
  backoffDelayMs,
  defaultSupervisorRuntime,
  ranAtLeast,
  STABLE_CONNECTION_MS,
  superviseLadder,
  type RuntimeOf,
} from "@shared/remote/supervisor";
import { containedSync } from "@shared/util/contained";
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
// rung) for as long as the child lives: a live connector that is not
// routable yet is waiting on DNS, not broken, and the child exiting is
// the one failure signal (a dead token makes cloudflared exit). The
// first attempt waits out CNAME propagation on purpose. Probing a
// brand-new hostname within a second of provisioning it earns an
// NXDOMAIN that the OS resolver then caches for the zone's negative
// TTL (30 minutes on Cloudflare), during which no probe from this
// machine can succeed and every restart would re-provision for
// nothing. A child that merely survives a spawn says nothing about
// routability, and a web client whose ONLY candidate is the tunnel
// would burn its keeper's backoff rungs against a not-yet-routable
// advertisement (a transient failure, so it retries forever -- but
// each wasted rung pushes the next attempt further out).
export const TUNNEL_PROBE_DELAYS_MS: readonly number[] = [5_000, 8_000];
// The ladder for a tunnel the Worker REUSED, which is every launch
// after a device's first. Its hostname resolved before, so there is no
// propagation to wait out and no negative answer to earn: all a probe
// waits on is the connector registering at the edge, a second or two.
// Until it passes the device advertises no tunnel candidate, so on the
// ladder above a web client (whose only candidate is the tunnel) could
// not reach a freshly launched device for its first five seconds.
export const TUNNEL_PROBE_DELAYS_REUSED_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000,
];
// Past this, one warning names the hostname that is still not
// routable, so a stuck tunnel is visible in the log without the
// runner giving up on a healthy child, and the probe slows to the
// rung below: a hostname that stays unroutable (a negative DNS answer
// cached for the zone's TTL, a deleted record) costs one edge request
// a minute, not one every eight seconds, for as long as the child
// lives.
export const TUNNEL_PROBE_WARN_MS = 60_000;
export const TUNNEL_PROBE_SLOW_MS = 60_000;
// Past the deadline, the child is treated exactly like one that died:
// killed and rescheduled on the backoff ladder, and since it never
// reached readiness the restart re-provisions rather than reusing its
// possibly-dead token. Two deadlines, chosen by what the Worker said:
// a tunnel it just CREATED (dnsCreated) has a brand-new DNS record
// that may take a while to resolve, so it gets one long enough to
// outlast a cached negative answer. A reused tunnel resolved before,
// so a probe that keeps failing means a deleted record or a stale
// ingress, and the re-provision is what repairs those.
export const TUNNEL_PROBE_DEADLINE_MS = 60_000;
export { TUNNEL_PROBE_DEADLINE_FRESH_MS };

// One probe attempt's own bound, so a black-holed edge cannot wedge the
// probe chain. The attempt's fetch is aborted with it.
const PROBE_ATTEMPT_TIMEOUT_MS = 5_000;

// The child's argv and env, pure so the check can pin the secret
// discipline: the connector token rides ONLY in env.TUNNEL_TOKEN
// (cloudflared reads it there), never argv, so `ps` output and spawn
// logging can never leak it.
export function cloudflaredArgs(): string[] {
  // --no-autoupdate: cloudflared otherwise checks for a newer release
  // and replaces its own binary, which would break the signature of
  // the copy the app ships. The version is pinned in
  // shared/packaging/cloudflaredDist.mts and bumped with the app.
  //
  // --ha-connections: the default four edge connections are for
  // redundancy, not throughput (a stream rides one and dies with it
  // either way), and their idle keepalives were most of the app's
  // energy floor. One carries everything this tunnel does. If it
  // drops, cloudflared reconnects and a peer's connect attempt in
  // that window fails once and retries. A `tunnel` flag, so it goes
  // before `run`.
  return ["tunnel", "--no-autoupdate", "--ha-connections", "1", "run"];
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

// The renderer-safe status snapshot: never the connector token.
// Operator detail for a failure goes to the log, not here. The state
// vocabulary is the wire's (HubStatusSchema.tunnel in
// shared/ipc/modules/hub.ts), imported rather than redeclared so the
// runner and the status surface cannot drift. off: not wanted
// (listener down, opted out, signed out). no-binary: wanted, but no
// usable cloudflared. unconfigured: the Worker has no tunnel env
// (typed answer, cached for the process lifetime). starting:
// provisioning, spawning, or probing readiness. up: the child is
// probed-routable and the tunnel is advertised. error: the last
// attempt failed, with either a backoff restart scheduled or (for a
// denied provision) nothing until the next reconcile trigger.
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
  // The hub Worker's provision call for the given listener port.
  // Throws TunnelUnconfiguredError when the Worker has no tunnel env,
  // TunnelProvisionDeniedError on any other 4xx refusal.
  provision(port: number): Promise<{
    hostname: string;
    connectorToken: string;
    // Absent from an older Worker: read as a reused tunnel.
    dnsCreated?: boolean;
  }>;
  // Test seam. The default spawns the real cloudflared with the token
  // in env only.
  spawnTunnel?: (binaryPath: string, connectorToken: string) => TunnelChild;
  // One readiness probe attempt: true when the hostname routes from
  // the edge to the local listener. The default GETs the hostname over
  // HTTPS and reads any edge answer that the LISTENER produced (the
  // 426 a ws server earns for a non-upgrade GET) as routable. The
  // signal aborts an attempt the runner gave up on (its own bound, the
  // deadline, a teardown).
  probeTunnel?: (hostname: string, signal: AbortSignal) => Promise<boolean>;
  // Where the live child's pid is recorded so a crashed Electron's
  // orphaned cloudflared can be reaped on the next launch. A getter
  // because the userData path is an app-ready fact. When absent
  // (tests), the bookkeeping is disabled.
  pidFilePath?: () => string;
  // Fired on every state transition so the owner can fan status out.
  onChange?: () => void;
  // Where the runner's fibers run. Real callers take Effect's default
  // services. The direct-plane check passes a ManagedRuntime built on
  // TestClock.layer() and walks the ladders with TestClock.adjust.
  runtime?: RuntimeOf<never>;
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
  // arrives here). Resolves once the attempt it started has spawned
  // a child (and is probing it), parked, or scheduled a retry.
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
async function probeTunnelEdge(
  hostname: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(`https://${hostname}`, { signal });
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

// The last successful provision for one port's fiber, held in memory
// only (the token is a bearer secret: it goes into a child's env and
// never anywhere observable), so a crash restart re-spawns without a
// Worker round trip. Fiber-local, so it dies with the port's fiber: a
// later start under a new port, or after a stop under a possibly
// different account, never fronts stale credentials.
type ProvisionCache = {
  provision: {
    hostname: string;
    connectorToken: string;
    dnsCreated: boolean;
  } | null;
  // Whether the most recently spawned child passed the readiness
  // probe. Reset on every spawn, so it always describes the child
  // whose crash a restart is recovering from. Reuse requires it: a
  // child that died without ever becoming routable may be holding a
  // dead token, so its successor re-provisions.
  ready: boolean;
};

// How one start attempt ended. A park waits for the next reconcile
// trigger when that trigger can change the verdict (no binary, a
// denied provision), and for nothing at all when it cannot (the
// cached unconfigured verdict). A retry climbs the ladder, from the
// bottom when the child had run stably.
type AttemptOutcome =
  | { kind: "park"; wakeable: boolean }
  | { kind: "retry"; detail: string; stable: boolean };

// What a reconcile shares with the port fiber it started.
type PortControl = {
  // Completed when the fiber's current attempt has spawned (and is
  // probing), parked, or scheduled a retry, and when the fiber ends,
  // which is what the reconcile that triggered the attempt awaits. A
  // wake replaces it first, so the waking reconcile awaits the attempt
  // it caused.
  settled: Deferred.Deferred<void>;
  // Set while the fiber is parked on a verdict the next reconcile
  // trigger can change. Completing it re-runs the attempt, with the
  // fiber's ladder position and provision cache intact.
  wake: Deferred.Deferred<void> | null;
};

type PortRun = {
  port: number;
  fiber: Fiber.Fiber<void>;
  control: PortControl;
};

export function createCloudflaredRunner(
  deps: CloudflaredRunnerDeps,
): CloudflaredRunner {
  const runtime = deps.runtime ?? defaultSupervisorRuntime;
  const spawnTunnel = deps.spawnTunnel ?? spawnCloudflared;
  const probeTunnel = deps.probeTunnel ?? probeTunnelEdge;
  // The runner's lifetime: every fiber is forked here, and stop()
  // closes it. Closed is terminal: a fork into it is interrupted before
  // it runs, so a reconcile that arrives or drains after quit began
  // does nothing, whatever it was asked to do.
  const scope = Scope.makeUnsafe();
  // Serializes reconciles IN CALL ORDER (shared/util/limit.ts says why
  // not a Semaphore), so a fast toggle cannot interleave one
  // reconcile's teardown with another's start, and the last call made
  // is the state that stands. stop() does not take it: quit must never
  // park behind an in-flight provision.
  const lifecycle = createLimiter(1);

  let status: TunnelStatus = { state: "off", hostname: null };
  // The port being fronted and the fiber fronting it, null when off.
  let run: PortRun | null = null;
  // The Worker answering "no tunnel env" is a deployment fact, cached
  // for the process lifetime: reconciles cannot change it, so they
  // must not keep paying the provision round trip to re-learn it.
  let workerUnconfigured = false;
  // A previous app instance's recorded child is reaped once per
  // process, before the first spawn.
  let stalePidReaped = false;

  // One onChange per real transition. The owner's callback runs inside
  // a fiber, where a throw would be a defect nothing reports, so it is
  // contained and logged.
  function setStatus(next: TunnelStatus): void {
    const changed =
      next.state !== status.state || next.hostname !== status.hostname;
    status = next;
    if (!changed) return;
    containedSync("[tunnel] onChange threw", () => deps.onChange?.());
  }

  function pidFilePathOf(): string | null {
    try {
      return deps.pidFilePath?.() ?? null;
    } catch {
      return null;
    }
  }

  const reapStaleOnce: Effect.Effect<void> = Effect.suspend(() => {
    const pidFile = pidFilePathOf();
    if (pidFile === null || stalePidReaped) return Effect.void;
    stalePidReaped = true;
    return Effect.promise(() => reapStaleChild(pidFile));
  });

  const writePidFile = (pid: number | undefined): Effect.Effect<void> =>
    Effect.suspend(() => {
      const pidFile = pidFilePathOf();
      if (pidFile === null || pid === undefined) return Effect.void;
      return Effect.promise(() =>
        writeFile(pidFile, `${pid}\n`, "utf8").catch(() => {}),
      );
    });

  const clearPidFile: Effect.Effect<void> = Effect.suspend(() => {
    const pidFile = pidFilePathOf();
    if (pidFile === null) return Effect.void;
    return Effect.promise(() => rm(pidFile, { force: true }).catch(() => {}));
  });

  // One readiness probe attempt, bounded on its own. A rejection, a
  // throw and a timeout all read as not routable.
  const probeOnce = (hostname: string): Effect.Effect<boolean> =>
    Effect.tryPromise({
      try: (signal) => probeTunnel(hostname, signal),
      catch: () => false,
    }).pipe(
      Effect.timeoutOption(PROBE_ATTEMPT_TIMEOUT_MS),
      Effect.map(Option.getOrElse(() => false)),
      Effect.orElseSucceed(() => false),
    );

  // The readiness probe chain for a freshly spawned child: attempts on
  // the probe ladder until one passes. A child that is merely not
  // routable yet is kept and probed on (the ladder's note). The caller
  // bounds the chain with the deadline. Deliberately NOT re-run after
  // "up": the child process exiting is the down signal, and a liveness
  // poll against the edge would spend a request per interval to learn
  // what the exit already tells us.
  const probeUntilRoutable = (
    hostname: string,
    fresh: boolean,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const delaysMs = fresh
        ? TUNNEL_PROBE_DELAYS_MS
        : TUNNEL_PROBE_DELAYS_REUSED_MS;
      const startedAt = yield* Clock.currentTimeMillis;
      let warned = false;
      for (let attempt = 0; ; attempt += 1) {
        yield* Effect.sleep(
          warned ? TUNNEL_PROBE_SLOW_MS : backoffDelayMs(delaysMs, attempt),
        );
        if (yield* probeOnce(hostname)) return;
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
        if (!warned && elapsedMs >= TUNNEL_PROBE_WARN_MS) {
          warned = true;
          console.warn(
            `[tunnel] ${hostname} is still not routable after ` +
              `${Math.round(TUNNEL_PROBE_WARN_MS / 1000)}s, probing on ` +
              "(a fresh hostname resolves once DNS catches up)",
          );
        }
      }
    });

  // One child, from spawn to its end: exited on its own, or killed at
  // the probe deadline. The child is the scope's resource, so the kill
  // and the pid-file cleanup run however the scope closes, an
  // interrupt included.
  const runChild = (
    binaryPath: string,
    provision: NonNullable<ProvisionCache["provision"]>,
    cache: ProvisionCache,
    signalSettled: () => void,
  ): Effect.Effect<AttemptOutcome, unknown> =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hostname } = provision;
        const exited = Deferred.makeUnsafe<string>();
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const child = yield* Effect.try({
              try: () => spawnTunnel(binaryPath, provision.connectorToken),
              catch: (error) => error,
            });
            child.onExit((detail) => {
              Deferred.doneUnsafe(exited, Effect.succeed(detail));
            });
            yield* writePidFile(child.pid);
            return child;
          }),
          (child) =>
            Effect.sync(() => {
              if (!Deferred.isDoneUnsafe(exited)) child.kill();
            }).pipe(Effect.andThen(clearPidFile)),
        );
        const spawnedAt = yield* Clock.currentTimeMillis;
        cache.ready = false;
        setStatus({ state: "starting", hostname });
        signalSettled();
        // Past the deadline the child is treated exactly like one that
        // died, except that it is killed first (the scope's release).
        const deadlineMs = provision.dnsCreated
          ? TUNNEL_PROBE_DEADLINE_FRESH_MS
          : TUNNEL_PROBE_DEADLINE_MS;
        const ended = yield* Effect.raceFirst(
          Deferred.await(exited).pipe(
            Effect.map((detail) => ({ kind: "exited" as const, detail })),
          ),
          probeUntilRoutable(hostname, provision.dnsCreated).pipe(
            Effect.as(true),
            Effect.timeoutOrElse({
              duration: deadlineMs,
              orElse: () => Effect.succeed(false),
            }),
            Effect.flatMap((routable) =>
              routable
                ? Effect.sync(() => {
                    cache.ready = true;
                    // The hostname resolves now, so a later child of
                    // the same provision is held to the short deadline.
                    provision.dnsCreated = false;
                    setStatus({ state: "up", hostname });
                    console.info(`[tunnel] up at ${hostname}`);
                  }).pipe(Effect.andThen(Effect.never))
                : Effect.succeed({ kind: "deadline" as const }),
            ),
          ),
        );
        if (ended.kind === "deadline") {
          return {
            kind: "retry" as const,
            detail: `tunnel at ${hostname} never became routable`,
            stable: false,
          };
        }
        // Stable-reset rule, like the socket supervisor's: a child that
        // held the tunnel past the stable window broke the failure
        // streak, anything shorter climbs the ladder.
        return {
          kind: "retry" as const,
          detail: ended.detail,
          stable: yield* ranAtLeast(spawnedAt, TUNNEL_STABLE_MS),
        };
      }),
    );

  // One start attempt for a port. Never fails: a typed refusal parks,
  // anything else (a provision error, a throwing spawn, a dying step)
  // retries on the ladder, and only an interrupt passes through.
  const attempt = (
    port: number,
    cache: ProvisionCache,
    signalSettled: () => void,
  ): Effect.Effect<AttemptOutcome> =>
    Effect.gen(function* () {
      if (workerUnconfigured) {
        setStatus({ state: "unconfigured", hostname: null });
        return { kind: "park", wakeable: false } as const;
      }
      const binaryPath = yield* Effect.tryPromise({
        try: () => deps.resolveBinary(),
        catch: (error) => error,
      });
      if (binaryPath === null) {
        // Logged on the transition into no-binary only, not once per
        // reconcile that re-enters it.
        if (status.state !== "no-binary") {
          console.info(
            "[tunnel] no usable cloudflared (the cloudflaredPath config " +
              "key, the bundled copy, PATH), tunnel endpoints are off",
          );
        }
        setStatus({ state: "no-binary", hostname: null });
        return { kind: "park", wakeable: true } as const;
      }
      // Not advertised from here until a probe passes: "starting"
      // reads as tunnelUrl() null through the awaits below.
      setStatus({ state: "starting", hostname: null });
      yield* reapStaleOnce;
      let provision = cache.ready ? cache.provision : null;
      if (provision === null) {
        const provisioned = yield* Effect.tryPromise({
          try: () => deps.provision(port),
          catch: (error) => error,
        });
        provision = {
          hostname: provisioned.hostname,
          connectorToken: provisioned.connectorToken,
          dnsCreated: provisioned.dnsCreated === true,
        };
        cache.provision = provision;
      }
      return yield* runChild(binaryPath, provision, cache, signalSettled);
    }).pipe(
      Effect.catchCause((cause): Effect.Effect<AttemptOutcome> => {
        // Any interruption in the cause is stop() or a port change at
        // work, even beside a defect from a release: let it through.
        if (Cause.hasInterrupts(cause)) {
          return Effect.failCause(cause as Cause.Cause<never>);
        }
        const error = Cause.squash(cause);
        if (error instanceof TunnelUnconfiguredError) {
          // A deployment fact, not a failure: cached so no later
          // reconcile retries it either.
          workerUnconfigured = true;
          setStatus({ state: "unconfigured", hostname: null });
          return Effect.succeed({ kind: "park", wakeable: false });
        }
        if (error instanceof TunnelProvisionDeniedError) {
          // Refused outright (a revoked credential's 401, an older
          // Worker deploy's 404): a timed retry re-presents the same
          // request, so park with NO retry scheduled. The next
          // reconcile trigger re-enters, which is exactly when the
          // inputs can have changed.
          setStatus({ state: "error", hostname: null });
          console.warn(
            `[tunnel] provisioning denied (${errorMessageOf(error)}), ` +
              "waiting for the next account or config change",
          );
          return Effect.succeed({ kind: "park", wakeable: true });
        }
        if (Cause.hasDies(cause)) {
          console.warn(`[tunnel] start attempt died: ${Cause.pretty(cause)}`);
        }
        return Effect.succeed({
          kind: "retry",
          detail: `tunnel start failed: ${errorMessageOf(error)}`,
          stable: false,
        });
      }),
    );

  // One port's supervision, from the reconcile that wanted it until it
  // is interrupted. The ladder position and the provision cache are
  // local, so a new port (a new fiber) starts from the bottom with no
  // cached credentials.
  const supervisePort = (
    port: number,
    control: PortControl,
  ): Effect.Effect<void> => {
    const signalSettled = (): void => {
      Deferred.doneUnsafe(control.settled, Effect.void);
    };
    const cache: ProvisionCache = { provision: null, ready: false };
    // Attempts until one asks for a retry. A park holds the rung where
    // it is: a woken fiber attempts again at once.
    const untilRetry = Effect.gen(function* () {
      while (true) {
        const outcome = yield* attempt(port, cache, signalSettled);
        if (outcome.kind === "retry") return outcome;
        if (!outcome.wakeable) {
          signalSettled();
          return yield* Effect.never;
        }
        const wake = Deferred.makeUnsafe<void>();
        control.wake = wake;
        signalSettled();
        yield* Deferred.await(wake);
      }
    });
    return superviseLadder(
      TUNNEL_BACKOFF_LADDER_MS,
      untilRetry,
      (outcome, delayMs) => {
        setStatus({ state: "error", hostname: null });
        console.warn(`[tunnel] ${outcome.detail}, retrying in ${delayMs}ms`);
        signalSettled();
      },
    ).pipe(Effect.ensuring(Effect.sync(signalSettled)));
  };

  // Interrupts the current port's fiber, which kills its child (the
  // child scope's release) and cancels whatever it was waiting on.
  const endRun: Effect.Effect<void> = Effect.suspend(() => {
    const ending = run;
    run = null;
    return ending === null ? Effect.void : Fiber.interrupt(ending.fiber);
  });

  const reconcileNow = (wanted: { port: number } | null): Effect.Effect<void> =>
    Effect.gen(function* () {
      // The connector a crashed run left behind is reaped on the first
      // reconcile whatever it wants: a signed-out boot never reaches a
      // start, and the orphan keeps fronting the hostname onto a port
      // anything local may rebind.
      yield* reapStaleOnce;
      if (wanted === null) {
        yield* endRun;
        setStatus({ state: "off", hostname: null });
        return;
      }
      const current = run;
      if (current !== null && current.port === wanted.port) {
        // No-op unless the fiber is parked on a verdict this trigger
        // can change: a live child, a scheduled retry and the cached
        // unconfigured verdict are all already the right response to
        // this port, and restarting here would reset a failing
        // runner's backoff on every unrelated config write.
        const wake = current.control.wake;
        if (wake === null) return;
        current.control.wake = null;
        const settled = Deferred.makeUnsafe<void>();
        current.control.settled = settled;
        Deferred.doneUnsafe(wake, Effect.void);
        yield* Deferred.await(settled);
        return;
      }
      // Downgrade BEFORE killing: from here to a successful probe the
      // connector is not serving, and "starting" (which reads as
      // tunnelUrl() null) must never advertise a dead child. The
      // cached unconfigured verdict stays as it is.
      if (!workerUnconfigured) setStatus({ state: "starting", hostname: null });
      yield* endRun;
      const control: PortControl = {
        settled: Deferred.makeUnsafe<void>(),
        wake: null,
      };
      const fiber = yield* Effect.forkIn(
        supervisePort(wanted.port, control),
        scope,
      );
      run = { port: wanted.port, fiber, control };
      yield* Deferred.await(control.settled);
    });

  return {
    reconcile: (wanted) =>
      lifecycle(() =>
        runtime.runPromise(
          Effect.forkIn(reconcileNow(wanted), scope).pipe(
            Effect.flatMap(Fiber.join),
            // Interrupted means stop() won: in flight, queued, or after
            // (a fork into the closed scope is interrupted at once).
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.void
                : Effect.failCause(cause),
            ),
          ),
        ),
      ),
    stop: () => {
      // Pre-empt, do not queue: the status goes off now, and closing
      // the scope interrupts an in-flight reconcile (a provision it was
      // waiting on included), every queued one, and the port's fiber,
      // whose child is killed on the way out. Resolves once all of them
      // are gone. Idempotent: closing a closed scope does nothing.
      setStatus({ state: "off", hostname: null });
      return runtime.runPromise(Scope.close(scope, Exit.void));
    },
    status: () => ({ ...status }),
    tunnelUrl: () =>
      status.state === "up" && status.hostname !== null
        ? `wss://${status.hostname}`
        : null,
  };
}
