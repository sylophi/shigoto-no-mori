import {
  compareAppVersions,
  isPrereleaseVersion,
  releaseVersionOf,
} from "@shared/releases";
import type { UpdaterState } from "@shared/schemas";

// Which devices are behind the newest app release, for the update toast
// and Settings' Update all (hooks/system/useUpdater.ts), kept free of
// React and the bridge so it can be proven on its own.

// A device behind the newest release this window knows of: `staged`
// when its update is a restart away, else it restarts once it has
// fetched it (downloading, or not found yet since its last check
// predates the release).
export interface OutdatedDevice {
  staged: boolean;
}

export interface KnownUpdates {
  // The newest release any of these devices has found, staged or
  // downloading. null while none has found one.
  latest: string | null;
  // The oldest build among the devices behind it, so the update toast
  // can say what the update brings the furthest behind of them. null
  // while none is behind, or none of them has named its build.
  oldest: string | null;
  // deviceId to its update, in the order the devices came.
  outdated: Readonly<Record<string, OutdatedDevice>>;
}

// One device's updater, as findOutdated reads it: `running` is the
// build it runs ("" while unknown), `state` its updater state
// (undefined until read).
export interface DeviceUpdater {
  deviceId: string;
  running: string;
  state: UpdaterState | undefined;
}

// One device finding a release is word enough that it is out, so a
// device whose own check hasn't come round yet counts as behind too, by
// the build it runs. Unknown for a peer whose welcome hasn't named it,
// which doesn't count. Neither does a build that doesn't update itself
// (a dev build), nor one off the beta ride behind a prerelease: its
// own check stays on full releases (cli/updater.go pickRelease), so it
// would never find it.
export function findOutdated(devices: readonly DeviceUpdater[]): KnownUpdates {
  let latest: string | null = null;
  for (const { state } of devices) {
    const found =
      state?.kind === "ready" || state?.kind === "downloading"
        ? state.version
        : undefined;
    if (
      found !== undefined &&
      (latest === null || compareAppVersions(found, latest) === 1)
    ) {
      latest = found;
    }
  }
  const outdated: Record<string, OutdatedDevice> = {};
  let oldest: string | null = null;
  for (const { deviceId, running, state } of devices) {
    const behind =
      state?.kind === "ready" ||
      state?.kind === "downloading" ||
      (latest !== null &&
        state !== undefined &&
        state.kind !== "unsupported" &&
        (!isPrereleaseVersion(latest) || isPrereleaseVersion(running)) &&
        compareAppVersions(running, latest) === -1);
    if (!behind) continue;
    outdated[deviceId] = { staged: state?.kind === "ready" };
    if (
      releaseVersionOf(running) !== "" &&
      (oldest === null || compareAppVersions(running, oldest) === -1)
    ) {
      oldest = running;
    }
  }
  return { latest, oldest, outdated };
}
