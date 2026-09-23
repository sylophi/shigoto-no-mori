// Reconnect supervisor for one remote connection (in shared/ so the main-process hub socket reuses
// it). It is the SINGLE owner of retry for a connection: nothing else
// drives the connect function for it, so there is exactly one backoff
// ladder and one sleeping fiber per connection, never a fan of
// overlapping reconnect loops.
//
// State machine, copying t3's discipline:
//   idle -> connecting -> connected -> backoff -> connecting -> ...
//                              \-> blocked (terminal until inputs change)
// A connection that STAYS OPEN past the stable threshold resets the
// ladder to the bottom, so a healthy link that blips once does not
// inherit a punishing delay. A blocking close (a wrong token on the LAN
// path, a revoked device on the hub path) goes to blocked with NO
// further retry: those failures must block rather than spin into a
// hammering loop. Every other close backs off.
//
// One Effect fiber runs the whole loop. stop() interrupts it, which
// cancels a dial in flight (the connect effect is interrupted, and a
// promise-backed one sees its AbortSignal fire), a sleep on the
// ladder, or a wait on the live socket, and the interruption closes the
// connection it was holding. There is no running flag to check after
// each step: an interrupted fiber does not take the next one.
//
// Deterministic on purpose: the ladder is fixed with no random jitter
// (the renderer runtime forbids Math.random anyway), and time comes
// from Effect's Clock, so a test can run the loop under a TestClock
// and assert the ladder and the reset without sleeping real seconds.
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Fiber,
  type ManagedRuntime,
} from "effect";
import {
  connectDevice,
  type ConnectDeviceOptions,
  type DeviceConnection,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import { CLOSE_AUTH_FAILED } from "@shared/ipc/socket/frames";

// Backoff delays in milliseconds, capped at the last rung. Fixed and
// jitter-free so a test asserts the exact sequence.
export const BACKOFF_LADDER_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
];

// A connection open at least this long before it drops is treated as
// healthy, so its next reconnect starts the ladder from the bottom.
export const STABLE_CONNECTION_MS = 30_000;

// How long a freshly provisioned tunnel is probed before the host
// gives up and re-provisions (host/direct/cloudflared.ts): its DNS
// record is new and may take this long to route. Shared so the
// registry's "tunnel starting" note quotes the same figure.
export const TUNNEL_PROBE_DEADLINE_FRESH_MS = 45 * 60_000;

export type SupervisorStatus =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "connected"; remoteDeviceId: string; remoteAppVersion: string }
  | { phase: "backoff"; attempt: number; delayMs: number }
  | { phase: "blocked"; reason: BlockReason; message: string }
  | { phase: "stopped" };

// Opaque timer handle: a number in the browser, a Timeout object under
// node. Only handed back to clearTimeout.
export type SupervisorTimer = unknown;

// Injected time source for the runners that still schedule their own
// timers (the direct keeper, the cloudflared runner). The supervisor
// itself reads Effect's Clock. Goes with those runners' conversion.
export type SupervisorClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): SupervisorTimer;
  clearTimeout(timer: SupervisorTimer): void;
};

export const defaultSupervisorClock: SupervisorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// The hello facts and target for one device, minus the callbacks the
// supervisor owns.
type SupervisorParams = {
  url: string;
  token: string;
  appVersion: string;
  localDeviceId: string;
};

// The connect function: one dial attempt as an Effect, so stop()
// interrupts it and a failure carries the transport's error. The
// default wraps the real connectDevice; the hub connection supplies
// its own dial.
export type ConnectFn = (
  opts: ConnectDeviceOptions,
) => Effect.Effect<DeviceConnection, unknown>;

// The block-vs-retry verdict for a close code, injectable because each
// wire has its own terminal codes. A non-null verdict blocks with its
// message. The default is the LAN rule: only a wrong token blocks.
// The hub connection supplies its own classifier for the revoked and
// superseded close codes.
//
// Every classifier here is an ALLOWLIST of blocking codes, so an
// unrecognized code retries rather than wedging a device in a blocked
// state this build cannot explain.
// Why a blocked socket is blocked. Only "revoked" is the hub's verdict
// on this device (its close code says the device was removed from the
// account), which is what a device signs itself out on. "refused" is a
// ticket mint the hub would not serve, any 401/403, which a misdeployed
// hub produces for every device at once and which recovers on its own.
// "superseded" is another instance of this device taking the socket
// over, and "auth" is the LAN path's bad token.
export type BlockReason = "revoked" | "superseded" | "refused" | "auth";

// The one block a device acts on by leaving the account.
export function credentialRevoked(status: SupervisorStatus): boolean {
  return status.phase === "blocked" && status.reason === "revoked";
}

export type CloseClassifier = (
  code: number | null,
) => { reason: BlockReason; message: string } | null;

const AUTH_FAILED_MESSAGE = "authentication failed";

// Not exported: it is only the default classifier for this module. The
// hub path injects its own, and nothing else references it. The
// host's failed-auth lockout (CLOSE_AUTH_LOCKED_OUT) is pointedly NOT
// here: it is a temporary bench on the client IP, not a verdict on
// this device's token, so a LAN supervisor rides it out on the ladder
// instead of surfacing "authentication failed" for a credential that
// was never even read.
const lanCloseClassifier: CloseClassifier = (code) =>
  code === CLOSE_AUTH_FAILED
    ? { reason: "auth", message: AUTH_FAILED_MESSAGE }
    : null;

// The signal is the fiber's interruption: a dial that lands after
// stop() is closed here, in the same turn it lands, so it cannot leak
// a live socket.
const connectDeviceEffect: ConnectFn = (opts) =>
  Effect.callback<DeviceConnection, unknown>((resume, signal) => {
    connectDevice(opts).then(
      (connection) => {
        if (signal.aborted) connection.close();
        else resume(Effect.succeed(connection));
      },
      (error: unknown) => {
        resume(Effect.fail(error));
      },
    );
  });

type SupervisorOptions = {
  params: SupervisorParams;
  connect?: ConnectFn;
  classifyClose?: CloseClassifier;
  // Status observer for a device registry / a live UI.
  onStatus?: (status: SupervisorStatus) => void;
  // The live connection on a successful handshake, and null the moment
  // it is lost or torn down, so the registry can build or drop the
  // per-device api against it.
  onConnection?: (connection: DeviceConnection | null) => void;
  helloTimeoutMs?: number;
  // Where the loop's fiber runs. Real callers take Effect's default
  // services; a test passes a ManagedRuntime built on TestClock.layer()
  // and drives the ladder with TestClock.adjust.
  runtime?: SupervisorRuntime;
};

export type SupervisorRuntime = Pick<
  ManagedRuntime.ManagedRuntime<never, never>,
  "runFork" | "runPromise"
>;

// Effect's default services, the runtime every real caller runs on.
export const defaultSupervisorRuntime: SupervisorRuntime = {
  runFork: Effect.runFork,
  runPromise: Effect.runPromise,
};

export type Supervisor = {
  start(): void;
  // Resolves once the loop's fiber is gone: a dial in flight
  // cancelled, a held connection closed.
  stop(): Promise<void>;
  status(): SupervisorStatus;
};

// The ladder lookup, clamped at both ends. Exported with the ladder as
// a parameter so other supervised children (the cloudflared runner)
// share the one rule instead of copying it.
export function backoffDelayMs(
  ladder: readonly number[],
  attempt: number,
): number {
  const index = Math.min(Math.max(attempt, 0), ladder.length - 1);
  return ladder[index];
}

// What one attempt (a dial, then holding the socket until it drops)
// ends in: a block, which ends the loop, or a backoff, which climbs
// the ladder unless the socket had been up long enough to reset it.
type AttemptOutcome =
  | { kind: "blocked"; reason: BlockReason; message: string }
  | { kind: "backoff"; resetLadder: boolean };

// The owner's callbacks run inside the loop's fiber, so a throw from
// one would end the loop with a defect nothing reports. Contained and
// logged instead: the old timer-driven loop crashed the process on the
// same throw, which was louder but no more useful.
function guarded(what: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.warn(`[supervisor] ${what} threw: ${String(error)}`);
  }
}

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const connect = options.connect ?? connectDeviceEffect;
  const classifyClose = options.classifyClose ?? lanCloseClassifier;
  const runtime = options.runtime ?? defaultSupervisorRuntime;

  let status: SupervisorStatus = { phase: "idle" };
  let fiber: Fiber.Fiber<void> | null = null;

  function setStatus(next: SupervisorStatus): void {
    status = next;
    guarded("onStatus", () => options.onStatus?.(next));
  }

  function reportConnection(connection: DeviceConnection | null): void {
    guarded("onConnection", () => options.onConnection?.(connection));
  }

  // One dial and one hold. Never fails: every way the attempt can end
  // is an outcome the loop reads. The connection is recorded in the
  // same step the dial lands, and the interrupt hook wraps the whole
  // attempt, so a stop() that arrives at any point after the dial,
  // even re-entrantly from the connected status callback, closes it.
  const attempt: Effect.Effect<AttemptOutcome> = Effect.suspend(() => {
    let held: DeviceConnection | null = null;
    return attemptWith((connection) => {
      held = connection;
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          held?.close();
          held = null;
        }),
      ),
    );
  });

  const attemptWith = (
    hold: (connection: DeviceConnection | null) => void,
  ): Effect.Effect<AttemptOutcome> =>
    Effect.gen(function* () {
      setStatus({ phase: "connecting" });
      // Completed by the transport's close callback for a socket that
      // dropped on its own (the transport suppresses it for an owner
      // close), so the hold below wakes exactly then.
      const closed = Deferred.makeUnsafe<number | null>();
      const dialed = yield* connect({
        url: options.params.url,
        token: options.params.token,
        appVersion: options.params.appVersion,
        localDeviceId: options.params.localDeviceId,
        onClose: (code) => {
          Deferred.doneUnsafe(closed, Effect.succeed(code));
        },
        helloTimeoutMs: options.helloTimeoutMs,
      }).pipe(
        Effect.map((connection) => {
          hold(connection);
          return { ok: true as const, connection };
        }),
        // The whole cause, not only a typed failure: a connect effect
        // that dies (a thrown bug) must back off like a failed dial, not
        // end the loop silently in "connecting".
        Effect.catchCause((cause) => {
          // An interruption is stop() at work: let it through untouched.
          // An interrupt-only cause carries no failure, hence the
          // narrowing.
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause as Cause.Cause<never>);
          }
          if (Cause.hasDies(cause)) {
            console.warn(`[supervisor] dial died: ${Cause.pretty(cause)}`);
          }
          return Effect.succeed({
            ok: false as const,
            error: Cause.squash(cause),
          });
        }),
      );
      if (!dialed.ok) {
        // The transport tags a blocking close as blocked. Anything else
        // (hello timeout, host restart, network blip) is retryable, and a
        // failed attempt never counts as a stable connection.
        const error = dialed.error;
        if (error instanceof RemoteConnectError && error.blocked) {
          // A blocking close names itself through the classifier. A
          // blocking failure with no close code (a refused ticket mint)
          // names itself in the error.
          const verdict = classifyClose(error.code) ?? {
            reason: "refused" as const,
            message: error.message,
          };
          return { kind: "blocked", ...verdict };
        }
        return { kind: "backoff", resetLadder: false };
      }
      const connection = dialed.connection;
      const connectedAt = yield* Clock.currentTimeMillis;
      setStatus({
        phase: "connected",
        remoteDeviceId: connection.remoteDeviceId,
        remoteAppVersion: connection.remoteAppVersion,
      });
      reportConnection(connection);
      // Hold the socket until it drops. stop() interrupts the hold, and
      // the interrupt hook around the attempt closes the socket, so no
      // orphan stays live.
      const code = yield* Deferred.await(closed);
      // Dropped on its own: nothing left to close on an interrupt.
      hold(null);
      reportConnection(null);
      const verdict = classifyClose(code);
      if (verdict !== null) return { kind: "blocked", ...verdict };
      const openMs = (yield* Clock.currentTimeMillis) - connectedAt;
      return { kind: "backoff", resetLadder: openMs >= STABLE_CONNECTION_MS };
    });

  // The loop: attempt, then either end blocked or sleep one rung and
  // go again. The rung is local to the loop, so a new start() begins
  // at the bottom.
  const supervise: Effect.Effect<void> = Effect.gen(function* () {
    let rung = 0;
    while (true) {
      const outcome = yield* attempt;
      if (outcome.kind === "blocked") {
        // Terminal until inputs change: the owner drops and recreates
        // the supervisor when the url or token changes, which is what
        // unblocks.
        setStatus({
          phase: "blocked",
          reason: outcome.reason,
          message: outcome.message,
        });
        return;
      }
      if (outcome.resetLadder) rung = 0;
      const delayMs = backoffDelayMs(BACKOFF_LADDER_MS, rung);
      rung += 1;
      setStatus({ phase: "backoff", attempt: rung, delayMs });
      yield* Effect.sleep(delayMs);
    }
  });

  return {
    start(): void {
      if (fiber !== null) return;
      fiber = runtime.runFork(supervise);
    },
    async stop(): Promise<void> {
      if (fiber === null && status.phase === "stopped") return;
      const running = fiber;
      fiber = null;
      if (running !== null) await runtime.runPromise(Fiber.interrupt(running));
      // A start() that landed during the interrupt owns the status now.
      if (fiber !== null) return;
      reportConnection(null);
      setStatus({ phase: "stopped" });
    },
    status: () => status,
  };
}
