// Whether this machine's host answers this window: false from its link
// dropping (the host stopped, or the shell's watchdog stopped a host
// that went silent) until a dial lands on the host that replaces it.
// Desktop only; a hostless client has no host of its own.
import type { HostRestartsSchema } from "@shigomori/contracts/modules/window";
import type { HostRestartReason } from "@shigomori/ui/views/hostBand/HostBandView.tsx";
import type { QueryClient } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { isOwnAppDrop } from "@shared/remote/rpcTransport";
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import {
  type DeviceStatusView,
  THIS_DEVICE_NOT_RESPONDING_VIEW,
} from "@shigomori/ui/lib/deviceStatus.ts";

export const hostAnswering = createExternalStore(true);

// Why the shell last started the host again, published as the link
// lands on the new one (desktop.ts), for the band to say.
export const hostRestarted = createExternalStore<{
  readonly reason: HostRestartReason;
} | null>(null);

type HostRestarts = typeof HostRestartsSchema.Type;

// The shell's count of host restarts, against which each landing tells
// whether this window lived through one. The count as the window opens
// is the baseline, asked until the shell answers and before any
// landing's: without it, a first ask that failed made the next landing's
// count the baseline, and that restart went unsaid.
export const followHostRestarts = (ask: Effect.Effect<HostRestarts, unknown>) =>
  Effect.gen(function* () {
    const turn = yield* Semaphore.make(1);
    let seen = 0;
    const baseline = turn.withPermits(1)(
      ask.pipe(
        Effect.retry(Schedule.spaced("1 second")),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            seen = count;
          }),
        ),
        Effect.asVoid,
      ),
    );
    const landed = turn.withPermits(1)(
      ask.pipe(
        Effect.tap(({ count, reason }) =>
          Effect.sync(() => {
            if (count > seen && reason !== null) {
              hostRestarted.publish({ reason });
            }
            seen = Math.max(seen, count);
          }),
        ),
        Effect.ignore,
      ),
    );
    return { baseline, landed };
  });

// The reads the host's going cut, asked again as it answers once more:
// a read in its retries waits out React Query's backoff otherwise, and
// one that gave up (no retry) would stay failed until a focus.
export function askAgainOnHostReturn(
  queryClient: QueryClient,
  signal: AbortSignal,
): void {
  let answering = hostAnswering.get();
  const stop = hostAnswering.subscribe(() => {
    const now = hostAnswering.get();
    if (now && !answering) {
      const cut = queryClient.getQueryCache().findAll({
        predicate: (query) =>
          isOwnAppDrop(query.state.error) ||
          isOwnAppDrop(query.state.fetchFailureReason),
      });
      // A read waiting out its retry's delay is cancelled first: React
      // Query lets a fetch still out run on rather than start another.
      for (const { queryKey } of cut) {
        const exact = { queryKey, exact: true };
        void queryClient
          .cancelQueries(exact)
          .then(() => queryClient.refetchQueries(exact));
      }
    }
    answering = now;
  });
  signal.addEventListener("abort", stop, { once: true });
}

// This device's state where a surface tags it: none while its host
// answers (the glyph alone), and Not responding while it doesn't.
export function useThisDeviceStatus(): DeviceStatusView | null {
  return useExternalStore(hostAnswering)
    ? null
    : THIS_DEVICE_NOT_RESPONDING_VIEW;
}
