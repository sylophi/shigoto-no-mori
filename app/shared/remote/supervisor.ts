// Reconnect supervisor for one remote connection (in shared/ so the
// host's hub socket and the web client's reuse it). It is the SINGLE
// owner of retry for a connection: nothing else
// drives the connect function for it, so there is exactly one fiber
// and one restart schedule per connection, never a fan of overlapping
// reconnect loops. It runs for the length of the scope it is made in.
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
// Clock of the context the supervisor is made in, so a test on a
// TestClock asserts the ladder and the reset without sleeping real
// seconds. Uptime is monotonic elapsed time (`@shigomori/engine/elapsed`), and
// a wake starts again an uptime not yet past the stable threshold: a
// sleep is not time a connection proved itself healthy, and a clock
// step is no time at all.
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import { HubUpdateRequiredError } from "@shigomori/contracts/hubApi";
import type { HubStatus } from "@shigomori/contracts/modules/hub";
import {
  type DeviceConnection,
  RemoteConnectError,
} from "@shared/remote/deviceLink";
import { elapsedMillisUnsafe } from "@shigomori/engine/elapsed";

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

// The part of an established connection the supervisor's owner
// touches: the probe, and the remote identity the connected status
// names.
export type SupervisedConnection = Pick<
  DeviceConnection,
  "probe" | "remoteDeviceId" | "remoteAppVersion"
>;

// The connect function: one attempt, handed the supervisor's close
// handler, answering with the established connection, which lives as
// long as the scope it was opened in: the supervisor closes that scope
// once the connection dropped or the supervisor's own scope closes.
// The owner (the hub connection) supplies it, and a test can drive a
// stub instead of a real socket.
type ConnectFn = (
  onClose: (code: number | null) => void,
) => Effect.Effect<SupervisedConnection, unknown, Scope.Scope>;

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

// How long a refused ticket waits before it is asked again.
const REFUSED_RETRY = "2 minutes";

// The one block a device acts on by leaving the account.
export function credentialRevoked(status: SupervisorStatus): boolean {
  return status.phase === "blocked" && status.reason === "revoked";
}

export type CloseClassifier = (
  code: number | null,
) => { reason: BlockReason; message: string } | null;

type SupervisorOptions = {
  connect: ConnectFn;
  classifyClose: CloseClassifier;
  // Status observer for a device registry / a live UI.
  onStatus?: (status: SupervisorStatus) => void;
  // The live connection on a successful handshake, and null the moment
  // it is lost or torn down, so the registry can build or drop the
  // per-device api against it.
  onConnection?: (connection: SupervisedConnection | null) => void;
};

export type Supervisor = {
  // The network is back, the machine awake or a tab back: a backoff
  // wait ends now and the next attempt starts, instead of after the
  // rest of its rung, and a live connection not yet stable counts its
  // uptime again from this observation.
  dialNow(): void;
};

// A backoff wait that can be cut short, for a loop that should try
// again the moment the platform says the network is back. `now` ends
// the wait in progress, if any.
export type Wake = {
  readonly wait: (delay: Duration.Duration) => Effect.Effect<void>;
  readonly now: () => void;
};

export function makeWake(): Wake {
  let waiting: Deferred.Deferred<void> | null = null;
  return {
    wait: (delay) =>
      Effect.suspend(() => {
        const cut = Deferred.makeUnsafe<void>();
        waiting = cut;
        return Effect.raceFirst(Effect.sleep(delay), Deferred.await(cut)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (waiting === cut) waiting = null;
            }),
          ),
        );
      }),
    now: () => {
      if (waiting !== null) Deferred.doneUnsafe(waiting, Effect.void);
    },
  };
}

// A schedule whose waits are `wake` waits: the wait runs in the step,
// which answers no delay of its own. Last in a pipe, so what comes
// before it (a status tap, another ladder) sees the delay it waits.
const wakeable =
  (wake: Wake) =>
  <Out, In, E, R>(
    schedule: Schedule.Schedule<Out, In, E, R>,
  ): Schedule.Schedule<Out, In, E, R> =>
    schedule.pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.as(wake.wait(duration), Duration.zero),
      ),
    );

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

// The supervisor, dialing from the moment it is made until its scope
// closes, which ends the connection it holds and reports "stopped".
export const supervise = (
  options: SupervisorOptions,
): Effect.Effect<Supervisor, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { classifyClose } = options;
    const clock = yield* Clock.Clock;
    // Since when the live connection's uptime counts, null while none is.
    let upSince: number | null = null;
    const setStatus = (next: SupervisorStatus) =>
      Effect.sync(() => options.onStatus?.(next));

    // Terminal until the owner's next refresh, which drops and recreates
    // the supervisor: that is what unblocks. A refusal (any 401 or 403 on
    // the ticket, which a misdeployed hub gives every device at once) is
    // asked again on a slow schedule instead, so it ends with the hub's
    // fix and not with each device's next sign-in.
    const block = (reason: BlockReason, message: string) =>
      setStatus({ phase: "blocked", reason, message }).pipe(
        Effect.andThen(
          reason === "refused"
            ? Effect.sleep(REFUSED_RETRY).pipe(Effect.as(0))
            : Effect.never,
        ),
      );

    // One connection's life: the connect, then the socket until it
    // closes, in a scope of its own that ends the socket. Answers how
    // long it stayed up, which the restart schedule reads (a failed
    // attempt never counts as a stable connection), or blocks for good.
    const attempt = Effect.gen(function* () {
      yield* setStatus({ phase: "connecting" });
      const closed = yield* Deferred.make<number | null>();
      // Fires only for a socket that dropped on its own: the connection
      // stays silent for the close its scope makes.
      const connected = yield* Effect.result(
        options.connect((code) =>
          Deferred.doneUnsafe(closed, Exit.succeed(code)),
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
          return yield* block(verdict.reason, verdict.message);
        }
        return 0;
      }
      const connection = connected.success;
      upSince = elapsedMillisUnsafe(clock);
      yield* setStatus({
        phase: "connected",
        remoteDeviceId: connection.remoteDeviceId,
        remoteAppVersion: connection.remoteAppVersion,
      });
      options.onConnection?.(connection);
      const code = yield* Deferred.await(closed).pipe(
        Effect.ensuring(Effect.sync(() => options.onConnection?.(null))),
      );
      const uptime =
        upSince === null ? 0 : elapsedMillisUnsafe(clock) - upSince;
      upSince = null;
      const verdict = classifyClose(code);
      if (verdict !== null)
        return yield* block(verdict.reason, verdict.message);
      return uptime;
    }).pipe(Effect.scoped);

    const wake = makeWake();
    // Registered first, so it runs once the loop has stopped.
    yield* Effect.addFinalizer(() => setStatus({ phase: "stopped" }));
    yield* attempt.pipe(
      Effect.repeat(
        restartSchedule(BACKOFF_LADDER_MS).pipe(
          Schedule.tap(({ output, duration }) =>
            setStatus({
              phase: "backoff",
              attempt: output,
              delayMs: Duration.toMillis(duration),
            }),
          ),
          wakeable(wake),
        ),
      ),
      Effect.forkScoped,
    );
    return {
      dialNow: () => {
        // Uptime already past the threshold was earned: the run is
        // stable whatever ends it now.
        const now = elapsedMillisUnsafe(clock);
        if (upSince !== null && now - upSince < STABLE_CONNECTION_MS) {
          upSince = now;
        }
        wake.now();
      },
    };
  });
