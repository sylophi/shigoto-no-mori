// Tells each connected host that this window is looking at it, so the
// host keeps its background sweep ticking (the host's BackgroundFetch.ts has
// the design). Asked on this window's focus and on a session landing,
// when the host also reads its worktree rows again (a landed session's
// first reads come from its caches, as old as the last time anyone
// looked), then renewed within the lease the host hands back, for as
// long as this window stays focused. Boot-scoped like the device sync.
import { focusManager } from "@tanstack/react-query";
import { documentFocused } from "@/lib/focus";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { remoteDevicesAtom } from "./devices";
import { apiFor, onAccountLeft, onSessionLanded } from "./remoteDeviceSync";

// After a failed ask, while the window stays focused and the session
// up, asked again after these, capped at the last: each within the
// host's two-minute lease of the renewal before it.
const RETRY_MS: readonly [number, ...number[]] = [2_000, 5_000, 15_000, 30_000];

type Deps = {
  sweep: (deviceId: string, renewal: boolean) => Promise<{ leaseMs: number }>;
  // Whether this window still holds a session to the device. One that
  // dropped is asked again by its landing, not by a retry.
  connected: (deviceId: string) => boolean;
};

// The asks and their renewals per device, for as long as `attend(true)`
// holds. A failed ask (a request that timed out or lost its answer on a
// session that stayed up) is retried on RETRY_MS, and `retryNow` (the
// network back) asks every failed one at once.
export function makeSweepRenewals(deps: Deps, attendedAtStart: boolean) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Failed asks in a row, per device with a retry pending.
  const failures = new Map<string, number>();
  // Bumped by every ask, so the answer to a superseded one schedules nothing.
  const asks = new Map<string, number>();
  let attended = attendedAtStart;

  const cancel = (deviceId: string): void => {
    clearTimeout(timers.get(deviceId));
    timers.delete(deviceId);
  };

  const ask = (deviceId: string, renewal = false): void => {
    cancel(deviceId);
    const id = (asks.get(deviceId) ?? 0) + 1;
    asks.set(deviceId, id);
    const later = (delayMs: number, next: boolean) =>
      timers.set(
        deviceId,
        setTimeout(() => ask(deviceId, next), delayMs),
      );
    deps.sweep(deviceId, renewal).then(
      ({ leaseMs }) => {
        if (asks.get(deviceId) !== id) return;
        failures.delete(deviceId);
        if (attended) later(leaseMs / 2, true);
      },
      () => {
        if (asks.get(deviceId) !== id) return;
        if (!attended || !deps.connected(deviceId)) {
          failures.delete(deviceId);
          return;
        }
        const failed = failures.get(deviceId) ?? 0;
        failures.set(deviceId, failed + 1);
        later(RETRY_MS[Math.min(failed, RETRY_MS.length - 1)] ?? 0, renewal);
      },
    );
  };

  const stop = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    failures.clear();
    asks.clear();
  };

  return {
    // This window focused or not. Losing focus ends every renewal and retry.
    attend: (next: boolean, connectedDevices: readonly string[]): void => {
      if (next === attended) return;
      attended = next;
      if (!attended) return stop();
      for (const deviceId of connectedDevices) ask(deviceId);
    },
    landed: (deviceId: string): void => {
      if (attended) ask(deviceId);
    },
    retryNow: (): void => {
      for (const deviceId of failures.keys()) {
        if (timers.has(deviceId)) ask(deviceId, true);
      }
    },
    stop,
  };
}

export function startRemoteSweepRequests(
  registry: AtomRegistry.AtomRegistry,
): void {
  const connectedDevices = () =>
    registry
      .get(remoteDevicesAtom)
      .filter((device) => device.status.phase === "connected")
      .map((device) => device.deviceId);
  const renewals = makeSweepRenewals(
    {
      sweep: (deviceId, renewal) => {
        const api = apiFor(deviceId);
        return api.run(api.git.sweep({ renewal }));
      },
      connected: (deviceId) => connectedDevices().includes(deviceId),
    },
    documentFocused(),
  );
  focusManager.subscribe((focused) =>
    renewals.attend(focused, connectedDevices()),
  );
  window.addEventListener("online", renewals.retryNow);
  // Signing out drops every peer api. A renewal firing after that
  // would rebuild one just to be refused.
  onAccountLeft(renewals.stop);
  // Hears the sessions already up at boot as landings too, so this is
  // the boot-time ask as well.
  onSessionLanded(renewals.landed);
}
