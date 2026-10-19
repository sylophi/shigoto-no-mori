// Whether this machine's host answers this window: false from its link
// dropping (the host stopped, or the shell's watchdog stopped a host
// that went silent) until a dial lands on the host that replaces it.
// Desktop only; a hostless client has no host of its own.
import type { HostRestartReason } from "@shigomori/ui/views/hostBand/HostBandView.tsx";
import type { QueryClient } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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

// Why the shell last started the host again, for the band to say.
export const hostRestarted = createExternalStore<{
  readonly reason: HostRestartReason;
} | null>(null);

// The shell's word that it started the host again
// (window:hostRestarted, as the new host is up), said once this
// window's link lands there: at once when it already has, else at
// `landed`.
export function followHostRestarts(
  restarted: Stream.Stream<HostRestartReason>,
): { readonly heard: Effect.Effect<void>; readonly landed: () => void } {
  let pending: HostRestartReason | null = null;
  return {
    heard: Stream.runForEach(restarted, (reason) =>
      Effect.sync(() => {
        if (hostAnswering.get()) hostRestarted.publish({ reason });
        else pending = reason;
      }),
    ),
    landed: () => {
      if (pending === null) return;
      hostRestarted.publish({ reason: pending });
      pending = null;
    },
  };
}

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
