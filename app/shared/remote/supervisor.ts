// Reconnect supervisor for one remote connection (in shared/ so the main-process hub socket reuses
// it). It is the SINGLE owner of retry for a connection: nothing else
// drives the connect function for it, so there is exactly one fiber
// and one restart schedule per connection, never a fan of overlapping
// reconnect loops.
//
// State machine, copying t3's discipline:
//   idle -> connecting -> connected -> backoff -> connecting -> ...
//                              \-> blocked (terminal until inputs change)
// A connection that STAYS OPEN past the stable threshold resets the
// ladder to the bottom, so a healthy link that blips once does not
// inherit a punishing delay. A blocking close (a revoked device, a
// superseded socket) goes to blocked with NO further retry: those
// failures must block rather than spin into a hammering loop. Every
// other close backs off.
//
// Deterministic on purpose: the ladder is fixed with no random jitter
// (the renderer runtime forbids Math.random anyway), and time is the
// Clock of the context the loop runs in, so a test on a TestClock
// asserts the ladder and the reset without sleeping real seconds.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { HubUpdateRequiredError } from "@shigomori/contracts/hubApi";
import type { HubStatus } from "@shigomori/contracts/modules/hub";
import {
  type DeviceConnection,
  RemoteConnectError,
} from "@shared/remote/deviceLink";

// Backoff delays in milliseconds, capped at the last rung. Fixed and
// jitter-free so a test asserts the exact sequence.
export const BACKOFF_LADDER_MS: readonly [number, ...number[]] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
];

// A connection open at least this long before it drops is treated as
// healthy, so its next reconnect starts the ladder from the bottom.
export const STABLE_CONNECTION_MS = 30_000;

// Defined by the hub contract, whose schema validates it on the
// loopback.
export type SupervisorStatus = HubStatus["socket"];

// The part of an established connection the supervisor and its owner
// touch: the owner close, the probe, and the remote identity the
// connected status names.
export type SupervisedConnection = Pick<
  DeviceConnection,
  "close" | "probe" | "remoteDeviceId" | "remoteAppVersion"
>;

// The connect function: one attempt, handed the supervisor's close
// handler, resolving with the established connection. The owner (the
// hub connection) supplies it, and a test can drive a stub instead of
// a real socket.
export type ConnectFn = (
  onClose: (code: number | null) => void,
) => Promise<SupervisedConnection>;

// The block-vs-retry verdict for a close code, injected because each
// wire has its own terminal codes. A non-null verdict blocks with its
// message. The hub connection supplies its classifier for the revoked
// and superseded close codes.
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
// over. "update-required" is the hub's version floor turning this build
// away, which only an update ends.
type BlockReason = Extract<SupervisorStatus, { phase: "blocked" }>["reason"];

// The one block a device acts on by leaving the account.
export function credentialRevoked(status: SupervisorStatus): boolean {
  return status.phase === "blocked" && status.reason === "revoked";
}

export type CloseClassifier = (
  code: number | null,
) => { reason: BlockReason; message: string } | null;

type SupervisorOptions = {
  connect: ConnectFn;
  // What the loop runs in: the app's, or a test's with a TestClock.
  context?: Context.Context<never>;
  classifyClose: CloseClassifier;
  // Status observer for a device registry / a live UI.
  onStatus?: (status: SupervisorStatus) => void;
  // The live connection on a successful handshake, and null the moment
  // it is lost or torn down, so the registry can build or drop the
  // per-device api against it.
  onConnection?: (connection: SupervisedConnection | null) => void;
};

export type Supervisor = {
  start(): void;
  stop(): void;
};

// A restart ladder as a Schedule, for a supervised run
// that is repeated whenever it ends. Its input is how long the run
// lasted in milliseconds: one that stayed up for `stableMs` broke the
// failure streak, so the next restart starts the ladder from the
// bottom. Each restart climbs a rung, capped at the last.
export const restartSchedule = (
  ladder: readonly [number, ...number[]],
  stableMs: number = STABLE_CONNECTION_MS,
): Schedule.Schedule<number, number> =>
  Schedule.fromStep(
    Effect.sync(() => {
      let attempt = 0;
      return (_now: number, uptimeMs: number) => {
        if (uptimeMs >= stableMs) attempt = 0;
        const delay = Duration.millis(backoffDelayMs(ladder, attempt));
        attempt += 1;
        return Effect.succeed([attempt, delay] as [number, Duration.Duration]);
      };
    }),
  );

// The ladder lookup, clamped at both ends. Exported with the ladder as
// a parameter so other supervised children (the cloudflared runner)
// share the one rule instead of copying it.
export function backoffDelayMs(
  ladder: readonly [number, ...number[]],
  attempt: number,
): number {
  const index = Math.min(Math.max(attempt, 0), ladder.length - 1);
  return ladder[index] ?? ladder[0];
}

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const classifyClose = options.classifyClose;
  const run = Effect.runForkWith(options.context ?? Context.empty());

  let status: SupervisorStatus = { phase: "idle" };
  let loop: Fiber.Fiber<never> | null = null;

  const setStatus = (next: SupervisorStatus) =>
    Effect.sync(() => {
      status = next;
      options.onStatus?.(next);
    });

  // Terminal until the owner's next refresh, which drops and recreates
  // the supervisor: that is what unblocks.
  const block = (reason: BlockReason, message: string) =>
    setStatus({ phase: "blocked", reason, message }).pipe(
      Effect.andThen(Effect.never),
    );

  // One connection's life: the connect, then the socket until it
  // closes. Answers how long it stayed up, which the restart schedule
  // reads (a failed attempt never counts as a stable connection), or
  // blocks for good.
  // Interruptible only while it waits (the connect, the open socket,
  // a block): a stop between the connect landing and the socket's wait
  // still closes the socket.
  const attempt = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* setStatus({ phase: "connecting" });
      const closed = yield* Deferred.make<number | null>();
      const connected = yield* restore(
        Effect.callback<Result.Result<SupervisedConnection, unknown>>(
          (resume) => {
            let orphaned = false;
            // Fires only for a socket that dropped on its own: the
            // transport suppresses this for an owner-initiated close.
            Promise.resolve()
              .then(() =>
                options.connect((code) =>
                  Deferred.doneUnsafe(closed, Exit.succeed(code)),
                ),
              )
              .then(
                (connection) => {
                  // Torn down while the handshake was in flight: the
                  // orphan is closed so it does not leak a live socket.
                  if (orphaned) connection.close();
                  else resume(Effect.succeed(Result.succeed(connection)));
                },
                (error: unknown) => resume(Effect.succeed(Result.fail(error))),
              );
            return Effect.sync(() => {
              orphaned = true;
            });
          },
        ),
      );
      if (Result.isFailure(connected)) {
        const error = connected.failure;
        // The transport tags a blocking close as blocked. Anything
        // else (hello timeout, host restart, network blip) is
        // retryable.
        if (error instanceof RemoteConnectError && error.blocked) {
          // A blocking close names itself through the classifier. A
          // blocking failure with no close code (a refused ticket
          // mint) names itself in the error, and a hub that turned
          // this build away for its age says so in its own words.
          const verdict =
            classifyClose(error.code) ??
            (error.refusal instanceof HubUpdateRequiredError
              ? {
                  reason: "update-required" as const,
                  message: error.refusal.message,
                }
              : { reason: "refused" as const, message: error.message });
          return yield* restore(block(verdict.reason, verdict.message));
        }
        return 0;
      }
      const connection = connected.success;
      return yield* Effect.gen(function* () {
        const connectedAt = yield* Clock.currentTimeMillis;
        yield* setStatus({
          phase: "connected",
          remoteDeviceId: connection.remoteDeviceId,
          remoteAppVersion: connection.remoteAppVersion,
        });
        options.onConnection?.(connection);
        const code = yield* restore(Deferred.await(closed));
        options.onConnection?.(null);
        const verdict = classifyClose(code);
        if (verdict !== null) {
          return yield* restore(block(verdict.reason, verdict.message));
        }
        return (yield* Clock.currentTimeMillis) - connectedAt;
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => connection.close())));
    }),
  );

  const supervise = attempt.pipe(
    Effect.repeat(
      restartSchedule(BACKOFF_LADDER_MS).pipe(
        Schedule.tap(({ output, duration }) =>
          setStatus({
            phase: "backoff",
            attempt: output,
            delayMs: Duration.toMillis(duration),
          }),
        ),
      ),
    ),
    Effect.andThen(Effect.never),
  );

  return {
    start(): void {
      if (loop !== null) return;
      loop = run(supervise);
    },
    stop(): void {
      if (loop === null && status.phase === "stopped") return;
      const stopping = loop;
      loop = null;
      if (stopping !== null) run(Fiber.interrupt(stopping));
      options.onConnection?.(null);
      status = { phase: "stopped" };
      options.onStatus?.(status);
    },
  };
}
