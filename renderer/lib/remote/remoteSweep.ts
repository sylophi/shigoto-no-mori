// Tells each connected host that this window is looking at it, so the
// host keeps its background sweep ticking (main/electron/fetch.ts has
// the design). Asked on this window's focus and on a session landing,
// then renewed within the lease the host hands back, for as long as
// this window stays focused. Boot-scoped like remoteHostWatch.
import { focusManager } from "@tanstack/react-query";
import { documentFocused } from "@/lib/focus";
import { remoteDeviceStore } from "./devices";
import { apiFor, onSessionLanded } from "./remoteDeviceSync";

export function startRemoteSweepRequests(): void {
  const renewals = new Map<string, ReturnType<typeof setTimeout>>();
  let focused = documentFocused();

  const request = (deviceId: string): void => {
    clearTimeout(renewals.get(deviceId));
    renewals.delete(deviceId);
    apiFor(deviceId)
      .git.sweep()
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

  focusManager.subscribe((next) => {
    if (next === focused) return;
    focused = next;
    if (focused) {
      for (const device of remoteDeviceStore.getSnapshot()) {
        if (device.status.phase === "connected") request(device.deviceId);
      }
    } else {
      for (const timer of renewals.values()) clearTimeout(timer);
      renewals.clear();
    }
  });
  // Hears the sessions already up at boot as landings too, so this is
  // the boot-time ask as well. A landed session's first reads come
  // from the host's caches, as old as the last time anyone looked.
  onSessionLanded((deviceId) => {
    if (focused) request(deviceId);
  });
}
