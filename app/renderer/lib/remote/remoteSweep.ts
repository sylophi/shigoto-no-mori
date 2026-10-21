// Tells each connected host that this window is looking at it, so the
// host keeps its background sweep ticking (the host's BackgroundFetch.ts has
// the design). Asked on this window's focus and on a session landing,
// when the host also reads its worktree rows again (a landed session's
// first reads come from its caches, as old as the last time anyone
// looked), then renewed within the lease the host hands back, for as
// long as this window stays focused. Boot-scoped like the device sync.
import { isPeerRefusal } from "@shigomori/contracts/errors";
import { documentFocused, onWindowFocus } from "@/lib/focus";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { remoteDevicesAtom } from "./devices";
import { apiFor, onAccountLeft, onSessionLanded } from "./remoteDeviceSync";

type Deps = {
  sweep: (deviceId: string, renewal: boolean) => Promise<{ leaseMs: number }>;
  // Whether this window still holds a session to the device. One that
  // dropped is asked again by its landing, not by a retry.
  connected: (deviceId: string) => boolean;
};

// The asks and their renewals per device, for as long as `attend(true)`
// holds. A failed ask (a request that timed out or lost its answer on a
// session that stayed up) is asked again at the next renewal. A refusal
// (commands or sharing off on the peer) is the peer's answer, not a
// failure: it waits for the next focus or landing.
export function makeSweepRenewals(deps: Deps, attendedAtStart: boolean) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // The latest ask per device, from a count that never goes back, so the
  // answer to a superseded one (from before a blur, say) schedules
  // nothing.
  const latest = new Map<string, number>();
  let asked = 0;
  let attended = attendedAtStart;
  // Half the host's lease (BackgroundFetch.ts), once an answer says it.
  let renewMs = 60_000;

  const cancel = (deviceId: string): void => {
    clearTimeout(timers.get(deviceId));
    timers.delete(deviceId);
  };

  const ask = (deviceId: string, renewal = false): void => {
    cancel(deviceId);
    asked += 1;
    const id = asked;
    latest.set(deviceId, id);
    const later = (next: boolean) => {
      cancel(deviceId);
      timers.set(
        deviceId,
        setTimeout(() => ask(deviceId, next), renewMs),
      );
    };
    deps.sweep(deviceId, renewal).then(
      ({ leaseMs }) => {
        if (latest.get(deviceId) !== id) return;
        renewMs = leaseMs / 2;
        if (attended) later(true);
      },
      (error: unknown) => {
        if (latest.get(deviceId) !== id) return;
        if (!attended || !deps.connected(deviceId) || isPeerRefusal(error)) {
          return;
        }
        later(renewal);
      },
    );
  };

  const stop = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    latest.clear();
  };

  return {
    // This window focused or not. Losing focus ends every renewal.
    attend: (next: boolean, connectedDevices: readonly string[]): void => {
      if (next === attended) return;
      attended = next;
      if (!attended) return stop();
      for (const deviceId of connectedDevices) ask(deviceId);
    },
    landed: (deviceId: string): void => {
      if (attended) ask(deviceId);
    },
    stop,
  };
}

export function startRemoteSweepRequests(
  registry: AtomRegistry.AtomRegistry,
  signal: AbortSignal,
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
  const unfocus = onWindowFocus((focused) =>
    renewals.attend(focused, connectedDevices()),
  );
  signal.addEventListener(
    "abort",
    () => {
      unfocus();
      renewals.stop();
    },
    { once: true },
  );
  // Signing out drops every peer api. A renewal firing after that
  // would rebuild one just to be refused.
  onAccountLeft(renewals.stop);
  // Hears the sessions already up at boot as landings too, so this is
  // the boot-time ask as well.
  onSessionLanded(renewals.landed);
}
