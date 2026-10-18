import {
  compareAppVersions,
  isPrereleaseVersion,
  releaseVersionOf,
} from "@shigomori/contracts/releaseVersions";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import type { updaterContract } from "@shigomori/contracts/modules/updater";
import type { EffectClient } from "@shigomori/contracts/types";
import type * as Effect from "effect/Effect";
import { isOwnAppDrop } from "@shared/remote/rpcTransport";

// Which devices are behind the newest app release, and the restart into
// one, for the update toast and Settings (hooks/system/useUpdater.ts),
// kept free of React and the bridge so they can be proven on their own.

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
// (a dev build), nor a full build behind a prerelease: its own check
// stays on full releases (pickRelease in the engine's updateFeed.ts),
// so it would never find it.
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

// Asks a device to install or update, through its api (a HostApi's
// `updater` and `run`). This machine's own app going away under the
// call is the restart under way, or a host restart the shell's install
// carries on through: no failure of the install's, which the updater's
// state reports (the next app start's, when the swap or its relaunch
// failed).
export async function restartIntoUpdate(
  api: {
    readonly updater: Pick<
      EffectClient<typeof updaterContract>,
      "install" | "update"
    >;
    readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  },
  how: "install" | "update" = "install",
): Promise<void> {
  try {
    await api.run(api.updater[how]());
  } catch (error) {
    if (isOwnAppDrop(error)) return;
    throw error;
  }
}
