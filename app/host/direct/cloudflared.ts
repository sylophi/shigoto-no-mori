// The cloudflared runtime for tunnel endpoints: discover the binary,
// ask the hub Worker to provision this device's named tunnel against
// the direct listener's current loopback port, and supervise
// `cloudflared tunnel run` as a child process. The tunnel fronts
// 127.0.0.1 only (the ingress the Worker writes pins that), and the
// connector token is a bearer secret: it lives in memory, reaches the
// child via env (TUNNEL_TOKEN), never argv, and never appears in logs
// or status objects.
//
// Main reconciles the Tunnel alongside the direct listener, so
// sign-out, an account switch and the directConnections opt-out all
// land here as reconcile(null). The child lives in the scope of the
// supervision fiber reconcile starts, which closes when the wanted
// port changes and when the layer does.
//
// This file must stay Electron free (pnpm test host-boundary).
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  TunnelProvisionDeniedError,
  TunnelUnconfiguredError,
} from "@shared/account/service";
import type { TunnelState } from "@shigomori/contracts/modules/hub";
import {
  TUNNEL_PROBE_DEADLINE_FRESH_MS,
  BACKOFF_LADDER_MS,
  backoffDelayMs,
  STABLE_CONNECTION_MS,
} from "@shared/remote/supervisor";
import { restartSchedule } from "@shared/remote/restartSchedule";
import * as Processes from "@host/lib/util/processes";
import * as PromiseAdapter from "@host/lib/util/promiseAdapter";

// ---- pure deciders, exported for the direct-plane check ----

// Restart delays for a failing tunnel (a provision error, a child that
// exits), capped at the last rung: the socket supervisor's ladder plus
// one extra top rung, so a persistently failing cloudflared never
// re-spawns more than once a minute.
export const TUNNEL_BACKOFF_LADDER_MS: readonly [number, ...number[]] = [
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
export const TUNNEL_PROBE_DELAYS_MS: readonly [number, ...number[]] = [
  5_000, 8_000,
];
// The ladder for a tunnel the Worker REUSED, which is every launch
// after a device's first. Its hostname resolved before, so there is no
// propagation to wait out and no negative answer to earn: all a probe
// waits on is the connector registering at the edge, a second or two.
// Until it passes the device advertises no tunnel candidate, so on the
// ladder above a web client (whose only candidate is the tunnel) could
// not reach a freshly launched device for its first five seconds.
export const TUNNEL_PROBE_DELAYS_REUSED_MS: readonly [number, ...number[]] = [
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

export function cloudflaredEnv(connectorToken: string): Record<string, string> {
  return { TUNNEL_TOKEN: connectorToken };
}

// ---- binary discovery ----

// `-x` semantics via the binary itself: asking cloudflared for its
// version proves the path exists AND is executable in one probe, where
// a bare stat would pass a stray non-executable. A path that exists
// but will not run (a lost executable bit, Gatekeeper refusing an
// unsigned copy, the wrong architecture) is the one case the user can
// act on and cannot otherwise see, so it is logged. A missing file is
// not: that is the ordinary "ships none" answer. The probe is bounded
// so a wedged binary cannot stall a start attempt.
const PROBE_TIMEOUT_MS = 10_000;

const runsAsCloudflared = (path: string) =>
  Processes.exec(path, ["--version"], { timeout: PROBE_TIMEOUT_MS }).pipe(
    Effect.as(true),
    Effect.catchTags({
      CommandError: (error) =>
        error.reason === "not-found"
          ? Effect.succeed(false)
          : Effect.logWarning(
              `[tunnel] cloudflared at ${path} did not run: ${error.message}`,
            ).pipe(Effect.as(false)),
    }),
  );

// Resolution order: the configured override (a device-scoped config
// key, see cloudflaredPath in packages/contracts/src/schemas/config.ts), then the copy
// the app ships (the zero-install path, and the one a packaged build
// normally takes), then PATH for a build that carries none. Null means
// tunnels are off: the caller logs ONE clear line and reports the
// typed status, never an error loop.
export const resolveCloudflaredBinary = Effect.fn("resolveCloudflaredBinary")(
  function* (
    configuredPath: string | undefined,
    bundledPath: string | null,
  ): Effect.fn.Return<
    string | null,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    const configured = configuredPath?.trim() ?? "";
    if (configured !== "") {
      return (yield* runsAsCloudflared(configured)) ? configured : null;
    }
    if (bundledPath !== null && (yield* runsAsCloudflared(bundledPath))) {
      return bundledPath;
    }
    return yield* Processes.resolveOnPath("cloudflared");
  },
);

// ---- the supervised runner ----

// The renderer-safe status snapshot: never the connector token.
// Operator detail for a failure goes to the log, not here. The state
// vocabulary is the wire's (HubStatusSchema.tunnel in
// packages/contracts/src/modules/hub.ts), imported rather than redeclared so the
// runner and the status surface cannot drift. off: not wanted
// (listener down, opted out, signed out). no-binary: wanted, but no
// usable cloudflared. unconfigured: the Worker has no tunnel env
// (typed answer, cached for the process lifetime). starting:
// provisioning, spawning, or probing readiness. up: the child is
// probed-routable and the tunnel is advertised. error: the last
// attempt failed, with either a backoff restart scheduled or (for a
// denied provision) nothing until the next reconcile trigger.
type TunnelStatus = {
  state: TunnelState;
  hostname: string | null;
};

// What the hub Worker's provision call hands back for a listener port.
export type TunnelProvision = {
  hostname: string;
  connectorToken: string;
  // Absent from an older Worker: read as a reused tunnel.
  dnsCreated?: boolean;
};

// The hub Worker's provision call failed. `cause` is its error:
// TunnelUnconfiguredError when the Worker has no tunnel env,
// TunnelProvisionDeniedError on any other 4xx refusal.
export class TunnelProvisionError extends Schema.TaggedError<TunnelProvisionError>()(
  "TunnelProvisionError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The hub did not provision this device's tunnel.";
  }
}

export interface Options {
  // Resolves the usable binary, null when absent.
  readonly resolveBinary: Effect.Effect<
    string | null,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  // The hub Worker's provision call for the given listener port.
  readonly provision: (
    port: number,
  ) => Effect.Effect<TunnelProvision, TunnelProvisionError>;
  // One readiness probe attempt: true when the hostname routes from
  // the edge to the local listener. The default GETs the hostname over
  // HTTPS and reads any edge answer that the LISTENER produced (the
  // 426 a ws server earns for a non-upgrade GET) as routable.
  readonly probe?: ((hostname: string) => Effect.Effect<boolean>) | undefined;
  // Where the live child's pid is recorded so a crashed Electron's
  // orphaned cloudflared can be reaped on the next launch. A getter
  // because the userData path is an app-ready fact. When absent
  // (tests), the bookkeeping is disabled.
  readonly pidFilePath?: (() => string) | undefined;
  // Fired on every state transition so the owner can fan status out.
  readonly onChange?: (() => void) | undefined;
}

export class Tunnel extends Context.Service<
  Tunnel,
  {
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
    readonly reconcile: (
      wanted: { readonly port: number } | null,
    ) => Effect.Effect<void>;
    readonly status: Effect.Effect<TunnelStatus>;
    // The wss dial URL while the tunnel is healthy, else null. What the
    // connectInfo answer advertises.
    readonly tunnelUrl: Effect.Effect<string | null>;
  }
>()("sm/host/Tunnel") {}

// How long a SIGTERM'd child gets before SIGKILL. cloudflared closes
// its edge connections promptly, so this only bounds a wedged one.
const KILL_GRACE_MS = 3_000;

// The default readiness probe: a plain HTTPS GET of the tunnel
// hostname. The direct listener is a ws server, so a non-upgrade GET
// that actually REACHED it earns an HTTP 426 (or 400) relayed through
// the edge. A tunnel the edge cannot route yet answers 5xx (CF 530
// "no connector") or times out. Dependency-free on purpose: fetch is
// the platform global.
const probeTunnelEdge = (hostname: string) =>
  Effect.tryPromise((signal) => fetch(`https://${hostname}`, { signal })).pipe(
    Effect.map((response) => response.status < 500),
    Effect.timeoutOption(PROBE_ATTEMPT_TIMEOUT_MS),
    Effect.map(Option.getOrElse(() => false)),
    Effect.orElseSucceed(() => false),
  );

// The probe ladder after the first attempt, until the hostname routes
// or the deadline passes, read against the spawn time: past the
// warning threshold every attempt waits the slow rung.
const probeSchedule = (
  spawnedAt: number,
  delaysMs: readonly [number, ...number[]],
  deadlineMs: number,
) =>
  Schedule.fromStep(
    Effect.sync(() => {
      let attempt = 1;
      return (now: number, routable: boolean) => {
        if (routable || now - spawnedAt >= deadlineMs) {
          return Cause.done(routable);
        }
        const delay =
          now - spawnedAt >= TUNNEL_PROBE_WARN_MS
            ? TUNNEL_PROBE_SLOW_MS
            : backoffDelayMs(delaysMs, attempt);
        attempt += 1;
        return Effect.succeed([routable, Duration.millis(delay)] as [
          boolean,
          Duration.Duration,
        ]);
      };
    }),
  );

// What the runner knows across its attempts.
interface Memory {
  // The port the owner currently wants fronted, null when stopped.
  readonly wantedPort: number | null;
  // The last successful provision, held in memory only (the token is a
  // bearer secret: it goes into a child's env and never anywhere
  // observable), so a crash restart re-spawns without a Worker round
  // trip while the port is unchanged. Reuse requires the PREVIOUS
  // child to have reached probed readiness (`ready`): a child that died
  // without ever becoming routable may be holding a dead token, so its
  // successor re-provisions.
  readonly provision: {
    readonly port: number;
    readonly hostname: string;
    readonly connectorToken: string;
    readonly dnsCreated: boolean;
    readonly ready: boolean;
  } | null;
  // The Worker answering "no tunnel env" is a deployment fact, kept for
  // the process lifetime: reconciles cannot change it, so they must not
  // keep paying the provision round trip to re-learn it.
  readonly unconfigured: boolean;
  // A provision was DENIED (4xx: revoked credential, older Worker
  // deploy). Nothing retries it. The next reconcile trigger re-enters
  // instead, because only changed inputs (a re-sign-in, a redeploy) can
  // change the answer.
  readonly denied: boolean;
}

const stopped: Memory = {
  wantedPort: null,
  provision: null,
  unconfigured: false,
  denied: false,
};

const make = (options: Options) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const probeOnce = options.probe ?? probeTunnelEdge;
    const withSpawner = Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      spawner,
    );
    const status = yield* Ref.make<TunnelStatus>({
      state: "off",
      hostname: null,
    });
    const memory = yield* Ref.make<Memory>(stopped);
    const remember = (change: Partial<Memory>) =>
      Ref.update(memory, (current) => ({ ...current, ...change }));

    const setStatus = (next: TunnelStatus) =>
      Ref.getAndSet(status, next).pipe(
        Effect.flatMap((previous) =>
          previous.state === next.state && previous.hostname === next.hostname
            ? Effect.void
            : Effect.sync(() => options.onChange?.()),
        ),
      );

    const pidFile = Effect.sync(() => {
      try {
        return options.pidFilePath?.() ?? null;
      } catch {
        return null;
      }
    });

    // Kill a previous app instance's orphaned cloudflared, recorded in the
    // pid file: nothing reaps the child when Electron dies without running
    // its quit (a crash, a SIGKILL), so the next launch does. The
    // process NAME is verified before killing so a recycled pid never
    // takes out an innocent process. Residual exposure, accepted: when the
    // app is SIGKILLed and never launched again, the orphan connector
    // keeps running until the machine reboots or the user kills it.
    const reaped = yield* Ref.make(false);
    const reapStaleOnce = Effect.gen(function* () {
      const path = yield* pidFile;
      if (path === null || (yield* Ref.getAndSet(reaped, true))) return;
      const raw = yield* fs.readFileString(path).pipe(Effect.option);
      if (Option.isNone(raw)) return;
      const pid = Number.parseInt(raw.value.trim(), 10);
      // The same pid floor as scripts/process.ts safeKill: never signal
      // groups, self, or launchd on a corrupt file.
      if (Number.isInteger(pid) && pid >= 2) {
        const name = yield* Processes.exec("ps", [
          "-p",
          String(pid),
          "-o",
          "comm=",
        ]).pipe(Effect.option);
        if (
          Option.isSome(name) &&
          name.value.stdout.trim().toLowerCase().includes("cloudflared")
        ) {
          yield* Effect.try(() => process.kill(pid, "SIGKILL")).pipe(
            Effect.ignore,
          );
        }
      }
      yield* fs.remove(path, { force: true }).pipe(Effect.ignore);
    }).pipe(withSpawner);

    // The readiness probe chain for a freshly spawned child: attempts on
    // the probe ladder until routable, then advertise. A child that is
    // merely not routable yet is kept and probed on (the ladder's note),
    // up to the deadline. Deliberately NOT re-run after "up": the child
    // process exiting is the down signal, and a liveness poll against
    // the edge would spend a request per interval to learn what the
    // child's exit already says.
    const probe = (hostname: string, fresh: boolean, spawnedAt: number) => {
      const deadlineMs = fresh
        ? TUNNEL_PROBE_DEADLINE_FRESH_MS
        : TUNNEL_PROBE_DEADLINE_MS;
      const delaysMs = fresh
        ? TUNNEL_PROBE_DELAYS_MS
        : TUNNEL_PROBE_DELAYS_REUSED_MS;
      let warned = false;
      const attempt = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (!warned && now - spawnedAt >= TUNNEL_PROBE_WARN_MS) {
          warned = true;
          yield* Effect.logWarning(
            `[tunnel] ${hostname} is still not routable after ` +
              `${Math.round(TUNNEL_PROBE_WARN_MS / 1000)}s, probing on ` +
              "(a fresh hostname resolves once DNS catches up)",
          );
        }
        return yield* probeOnce(hostname);
      });
      return Effect.sleep(delaysMs[0]).pipe(
        Effect.andThen(
          attempt.pipe(
            Effect.repeat(probeSchedule(spawnedAt, delaysMs, deadlineMs)),
          ),
        ),
      );
    };

    // An attempt that ends on the retry rails, with no healthy run to
    // count.
    const failAttempt = (detail: string) =>
      setStatus({ state: "error", hostname: null }).pipe(
        Effect.andThen(Effect.logWarning(`[tunnel] ${detail}, retrying`)),
        Effect.as(0),
      );

    // Nothing to do until the next reconcile, which interrupts it.
    const park = Effect.never;

    // One start attempt for `port`, from the binary to the child's
    // end. Answers how long the child ran, which the restart ladder
    // reads: 0 for an attempt that never had a healthy child.
    const runOnce = (port: number): Effect.Effect<number> =>
      Effect.gen(function* () {
        // From here to a successful probe the connector is not serving,
        // and "starting" (which reads as tunnelUrl() null) must never
        // advertise a dead child.
        const previous = (yield* Ref.get(status)).state;
        yield* setStatus({ state: "starting", hostname: null });
        yield* remember({ denied: false });
        if ((yield* Ref.get(memory)).unconfigured) {
          yield* setStatus({ state: "unconfigured", hostname: null });
          return yield* park;
        }
        const binaryPath = yield* withSpawner(options.resolveBinary);
        if (binaryPath === null) {
          // Logged on the way into no-binary, not on every reconcile.
          if (previous !== "no-binary") {
            yield* Effect.logInfo(
              "[tunnel] no usable cloudflared (the cloudflaredPath config " +
                "key, the bundled copy, PATH), tunnel endpoints are off",
            );
          }
          yield* setStatus({ state: "no-binary", hostname: null });
          return yield* park;
        }
        const cached = (yield* Ref.get(memory)).provision;
        let provision =
          cached !== null && cached.port === port && cached.ready
            ? cached
            : null;
        if (provision === null) {
          const provisioned = yield* Effect.result(options.provision(port));
          if (Result.isFailure(provisioned)) {
            const error = provisioned.failure.cause;
            if (error instanceof TunnelUnconfiguredError) {
              // A deployment fact, not a failure: cached so no later
              // reconcile retries it either.
              yield* remember({ unconfigured: true });
              yield* setStatus({ state: "unconfigured", hostname: null });
              return yield* park;
            }
            yield* setStatus({ state: "error", hostname: null });
            if (error instanceof TunnelProvisionDeniedError) {
              // Refused outright (a revoked credential's 401, an older
              // Worker deploy's 404): a timed retry re-presents the
              // same request, so park until the next reconcile, which
              // is exactly when the inputs can have changed.
              yield* remember({ denied: true });
              yield* Effect.logWarning(
                `[tunnel] provisioning denied (${errorMessageOf(error)}), ` +
                  "waiting for the next account or config change",
              );
              return yield* park;
            }
            return yield* failAttempt(
              `tunnel start failed: ${errorMessageOf(error)}`,
            );
          }
          provision = {
            port,
            hostname: provisioned.success.hostname,
            connectorToken: provisioned.success.connectorToken,
            dnsCreated: provisioned.success.dnsCreated === true,
            ready: false,
          };
        }
        const { hostname, connectorToken, dnsCreated } = provision;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const spawned = yield* spawner
              .spawn(
                ChildProcess.make(binaryPath, cloudflaredArgs(), {
                  // The token rides ONLY in env, never argv.
                  env: cloudflaredEnv(connectorToken),
                  extendEnv: true,
                  // Output is dropped: cloudflared logs verbosely, and
                  // the exit plus our own status line carry everything
                  // supervision needs.
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                  forceKillAfter: KILL_GRACE_MS,
                }),
              )
              .pipe(Effect.result);
            if (Result.isFailure(spawned)) {
              return yield* failAttempt(
                `cloudflared failed to spawn: ${spawned.failure.message}`,
              );
            }
            const child = spawned.success;
            const spawnedAt = yield* Clock.currentTimeMillis;
            yield* remember({ provision: { ...provision, ready: false } });
            yield* setStatus({ state: "starting", hostname });
            const path = yield* pidFile;
            if (path !== null) {
              yield* fs
                .writeFileString(path, `${child.pid}\n`)
                .pipe(Effect.ignore);
              yield* Effect.addFinalizer(() =>
                fs.remove(path, { force: true }).pipe(Effect.ignore),
              );
            }
            const exited = child.exitCode.pipe(
              Effect.exit,
              Effect.map((exit) =>
                Exit.isSuccess(exit)
                  ? `cloudflared exited (code ${exit.value})`
                  : "cloudflared exited (a signal)",
              ),
            );
            const outcome = yield* Effect.raceFirst(
              exited,
              probe(hostname, dnsCreated, spawnedAt).pipe(
                Effect.flatMap((routable) =>
                  routable
                    ? Effect.gen(function* () {
                        // The hostname resolves now, so a later child of
                        // the same provision is held to the short
                        // deadline.
                        yield* remember({
                          provision: {
                            ...provision,
                            dnsCreated: false,
                            ready: true,
                          },
                        });
                        yield* setStatus({ state: "up", hostname });
                        yield* Effect.logInfo(`[tunnel] up at ${hostname}`);
                        return yield* exited;
                      })
                    : Effect.succeed(null),
                ),
              ),
            );
            if (outcome === null) {
              return yield* failAttempt(
                `tunnel at ${hostname} never became routable`,
              );
            }
            yield* failAttempt(outcome);
            return (yield* Clock.currentTimeMillis) - spawnedAt;
          }),
        );
      }).pipe(
        // Anything else this attempt did not expect goes onto the
        // retry rails like a provision failure.
        Effect.catchDefect((defect) =>
          failAttempt(`tunnel start failed: ${errorMessageOf(defect)}`),
        ),
      );

    const supervisor = yield* FiberHandle.make<never>();
    const lifecycle = yield* Semaphore.make(1);

    // A stop clears the cached provision: a later start under a
    // possibly different account must never front stale credentials.
    const stopNow = Effect.gen(function* () {
      // Not advertised from the moment the stop begins.
      yield* setStatus({ state: "off", hostname: null });
      yield* FiberHandle.clear(supervisor);
      yield* Ref.update(memory, (current) => ({
        ...stopped,
        unconfigured: current.unconfigured,
      }));
      yield* setStatus({ state: "off", hostname: null });
    });
    yield* Effect.addFinalizer(() => stopNow);

    const reconcile = Effect.fn("Tunnel.reconcile")(
      (wanted: { readonly port: number } | null) =>
        lifecycle.withPermit(
          Effect.gen(function* () {
            // The connector a crashed run left behind is reaped on the
            // first reconcile whatever it wants: a signed-out boot never
            // reaches a start, and the orphan keeps fronting the
            // hostname onto a port anything local may rebind.
            yield* reapStaleOnce;
            if (wanted === null) return yield* stopNow;
            const current = yield* Ref.get(status);
            const known = yield* Ref.get(memory);
            // No-op whenever the port is unchanged and the runner is not
            // "off": a live child, a scheduled retry and the cached
            // unconfigured verdict are all already the right response to
            // this port, so an unrelated config write leaves a failing
            // runner's ladder where it is. Two states do re-enter:
            // "no-binary" (a config write may have just named a usable
            // cloudflaredPath, and re-resolving is a probe with no Worker
            // round trip and no ladder to disturb) and a provision-denied
            // park, whose ONLY recovery path is the next reconcile
            // trigger.
            if (
              wanted.port === known.wantedPort &&
              current.state !== "off" &&
              current.state !== "no-binary" &&
              !known.denied
            ) {
              return;
            }
            // The old child is not advertised while it goes.
            yield* setStatus({ state: "starting", hostname: null });
            yield* FiberHandle.clear(supervisor);
            yield* remember({ wantedPort: wanted.port });
            yield* FiberHandle.run(
              supervisor,
              runOnce(wanted.port).pipe(
                Effect.repeat(
                  restartSchedule(TUNNEL_BACKOFF_LADDER_MS, TUNNEL_STABLE_MS),
                ),
                Effect.andThen(Effect.never),
              ),
            );
          }),
        ),
    );

    return Tunnel.of({
      reconcile,
      status: Ref.get(status),
      tunnelUrl: Ref.get(status).pipe(
        Effect.map((current) =>
          current.state === "up" && current.hostname !== null
            ? `wss://${current.hostname}`
            : null,
        ),
      ),
    });
  });

export const layer = (options: Options) => Layer.effect(Tunnel, make(options));

// The Promise face, for main/ipc/register.ts.
const promiseAdapter = PromiseAdapter.make<Tunnel>("The tunnel");
export const adapter = promiseAdapter.layer;

const onTunnel = <A>(f: (tunnel: Tunnel["Service"]) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    return yield* f(yield* Tunnel);
  });

export const tunnel = {
  // Nothing to reconcile once the app is quitting: the layer's close
  // has stopped the child.
  reconcile: (wanted: { readonly port: number } | null) =>
    promiseAdapter
      .run(onTunnel((t) => t.reconcile(wanted)))
      .catch(() => undefined),
  state: (): TunnelState =>
    promiseAdapter.runSyncOr(
      onTunnel((t) => t.status),
      () => ({ state: "off" as const, hostname: null }),
    ).state,
  tunnelUrl: (): string | null =>
    promiseAdapter.runSyncOr(
      onTunnel((t) => t.tunnelUrl),
      () => null,
    ),
};
