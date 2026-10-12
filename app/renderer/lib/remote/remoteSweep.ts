// Tells each connected host that this window is looking at it, so the
// host keeps its background sweep ticking (the host's BackgroundFetch.ts has
// the design). Asked on this window's focus and on a session landing,
// then renewed within the lease the host hands back, for as long as
// this window stays focused. Boot-scoped like the device sync.
import { focusManager } from "@tanstack/react-query";
import { documentFocused } from "@/lib/focus";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { remoteDevicesAtom } from "./devices";
import { apiFor, onAccountLeft, onSessionLanded } from "./remoteDeviceSync";

// The host's worktree rows read again, for an edit its watch missed.
function reread(deviceId: string): void {
  const api = apiFor(deviceId);
  void api.run(api.worktrees.reread()).catch(() => undefined);
}

export function startRemoteSweepRequests(
  registry: AtomRegistry.AtomRegistry,
): void {
  const renewals = new Map<string, ReturnType<typeof setTimeout>>();
  let focused = documentFocused();

  const request = (deviceId: string): void => {
    clearTimeout(renewals.get(deviceId));
    renewals.delete(deviceId);
    const api = apiFor(deviceId);
    api
      .run(api.git.sweep())
      .then(({ leaseMs }) => {
        if (!focused) return;
        renewals.set(
          deviceId,
          setTimeout(() => request(deviceId), leaseMs / 2),
        );
      })
      // A session that dropped rejects with "no direct connection".
      // The keeper's redial lands it again and onSessionLanded asks.
      .catch(() => undefined);
  };

  const stopRenewing = (): void => {
    for (const timer of renewals.values()) clearTimeout(timer);
    renewals.clear();
  };

  focusManager.subscribe((next) => {
    if (next === focused) return;
    focused = next;
    if (!focused) {
      stopRenewing();
      return;
    }
    for (const device of registry.get(remoteDevicesAtom)) {
      if (device.status.phase !== "connected") continue;
      request(device.deviceId);
      reread(device.deviceId);
    }
  });
  // Signing out drops every peer api. A renewal firing after that
  // would rebuild one just to be refused.
  onAccountLeft(stopRenewing);
  // Hears the sessions already up at boot as landings too, so this is
  // the boot-time ask as well. A landed session's first reads come
  // from the host's caches, as old as the last time anyone looked.
  onSessionLanded((deviceId) => {
    if (!focused) return;
    request(deviceId);
    reread(deviceId);
  });
}
