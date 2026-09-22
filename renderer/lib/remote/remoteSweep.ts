// Asks each connected host to run its background sweep (refs and PRs
// for every project) when someone here starts looking at it: on this
// window's focus, when a session to the host lands, and on a slow
// timer while this window stays focused. Hosts no longer sweep on
// their own while their window is unfocused (main/electron/fetch.ts),
// since a sweep nobody reads is a git and a gh spawn per project every
// minute. So the peer that is reading asks, and the host's freshness
// window folds every asker's request into one pass. Boot-scoped like
// remoteHostWatch: one subscription for the life of the window.
import { focusManager } from "@tanstack/react-query";
import { remoteDeviceStore } from "./devices";
import { apiFor, onSessionLanded } from "./remoteDeviceSync";

// Matches the host's own cadence while focused.
const SWEEP_INTERVAL_MS = 60_000;

function requestSweep(deviceId: string): void {
  // A session that dropped between the snapshot and the call rejects
  // with "no direct connection". The keeper's redial lands it again
  // and onSessionLanded asks again, so there is nothing to do here.
  apiFor(deviceId)
    .git.sweep()
    .catch(() => undefined);
}

function requestSweepEverywhere(): void {
  for (const device of remoteDeviceStore.getSnapshot()) {
    if (device.status.phase === "connected") requestSweep(device.deviceId);
  }
}

export function startRemoteSweepRequests(): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const sync = (focused: boolean) => {
    if (focused && timer === null) {
      requestSweepEverywhere();
      timer = setInterval(requestSweepEverywhere, SWEEP_INTERVAL_MS);
    } else if (!focused && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  sync(document.hasFocus() && document.visibilityState === "visible");
  focusManager.subscribe(sync);
  // A landed session's first reads come from the host's caches, which
  // are as old as the last time anyone looked at that host.
  onSessionLanded((deviceId) => {
    if (focusManager.isFocused()) requestSweep(deviceId);
  });
}
