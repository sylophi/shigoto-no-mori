import { updaterContract } from "@shigomori/contracts/modules/updater";
import { useMutation } from "@tanstack/react-query";
import * as Atom from "effect/reactivity/Atom";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { isUpdating } from "@shigomori/contracts/schemas";
import { apiOf, commandAccessOf } from "@/lib/remote/devices";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { usePeers } from "@/hooks/remote/useDevices";
import { useHasLocalHost } from "@/lib/localHost";
import {
  allUpdating,
  findOutdated,
  type KnownUpdates,
  type OutdatedDevice,
  restartIntoUpdate,
} from "@/lib/updates";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import { hostStateAtom } from "@/lib/runtime/atoms";
import { useApi } from "@/lib/runtime/pageApi";
import { useView, useViews, viewsOf } from "@/lib/runtime/viewHooks";

// One device's updater state, as its host pushes it on every change,
// seeded by its read (pushedState). A peer's starts again on each new
// session to it, which covers its restart into the new build.
const updaterStateAtom = Atom.family((deviceId: string) =>
  hostStateAtom(deviceId, (api) => ({
    read: api.updater.get(),
    push: api.pushes(updaterContract, "state"),
  })).pipe(Atom.setIdleTTL("1 minute")),
);

const updaterStatesAtom = viewsOf(updaterStateAtom);

const useUpdaterStates = (deviceIds: readonly string[]) =>
  useViews(updaterStatesAtom, deviceIds).map((state) => state.data);

// The updater of the device the host scope names: this window's own updater with no
// provider mounted, or a peer's over its direct session inside one,
// so the same Settings card answers for whichever device is selected.
export function useUpdater() {
  const { deviceId, api } = useHostScope();
  const view = useView(updaterStateAtom(deviceId));

  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state push is the single source of truth, and the updater state atom follows it
  const check = useMutation({
    mutationFn: () => api.run(api.updater.check()),
    meta: { errorTitle: "Couldn't check for updates" },
  });
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state push is the single source of truth, and the updater state atom follows it
  const install = useMutation({
    mutationFn: () => restartIntoUpdate(api),
    meta: { errorTitle: "Couldn't install the update" },
  });

  return {
    state: view.data ?? null,
    check,
    install,
    isError: view.error !== null,
    refetch: view.refetch,
  };
}

// This machine's last install's failure, when its installer failed (the
// swap, or the relaunch): the reason the relaunched app's updater holds
// until its first check.
export function useInstallFailure(): string | null {
  const page = useApi();
  const { data } = useView(
    useHasLocalHost() ? updaterStateAtom(page.deviceId) : null,
  );
  return data?.kind === "error" && data.install === true ? data.message : null;
}

// The devices this window could update right now: itself, plus every
// peer that is reachable and lets this device command it (a staged
// update behind a refused switch has no button to lead to). A peer is
// asked only once its verdict has landed, not on the optimistic
// in-flight reading the forms use: a dot that lights and then goes out
// is worse than one that lights a moment later. Each with its name and
// the build it runs ("" while unknown).
interface UpdateTarget {
  deviceId: string;
  label: string;
  api: HostApi;
  running: string;
}

function useUpdateTargets(): UpdateTarget[] {
  const page = useApi();
  const localDeviceId = page.deviceId;
  const hasLocalHost = useHasLocalHost();
  const reachable = usePeers().filter(
    (peer) => peer.hostsProjects && deviceStatusView(peer.status).reachable,
  );
  return [
    // This machine's updater, absent on a hostless client.
    ...(hasLocalHost
      ? [
          {
            deviceId: localDeviceId,
            // Mid-sentence in every line that names it.
            label: "this device",
            api: page,
            running: __APP_VERSION__,
          },
        ]
      : []),
    ...reachable.flatMap((peer) =>
      commandAccessOf(peer).granted
        ? [
            {
              deviceId: peer.deviceId,
              label: peer.label,
              api: page.peerApi(peer.deviceId),
              running: peer.appVersion,
            },
          ]
        : [],
    ),
  ];
}

// One device's update, from a place that names the device (the banner
// over an outdated peer's pages): it is told to fetch the newest
// release and restart into it, as Update all tells it, and `updating`
// holds until it has. Only for a device whose updater this build can
// call.
export function useUpdateDevice(deviceId: string) {
  const page = useApi();
  const state = useView(updaterStateAtom(deviceId)).data;
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state push is the single source of truth, and the updater state atom follows it
  const mutation = useMutation({
    mutationFn: () => restartIntoUpdate(apiOf(page, deviceId), "update"),
    meta: { errorTitle: "Couldn't update the device" },
  });
  return {
    update: () => mutation.mutate(),
    updating: mutation.isPending || isUpdating(state),
  };
}

// The updates this window could install right now, as deviceId to the
// staged version, the local machine's first. What the sidebar's
// Settings dot, Settings' General row and its device tabs flag.
export function useStagedUpdates(): Readonly<Record<string, string>> {
  const targets = useUpdateTargets();
  const states = useUpdaterStates(targets.map((target) => target.deviceId));
  const staged: Record<string, string> = {};
  targets.forEach((target, index) => {
    const state = states[index];
    if (state?.kind === "ready") staged[target.deviceId] = state.version;
  });
  return staged;
}

// Every device this window could update that is behind the newest
// release any of them has found (findOutdated). What the update toast
// offers and Settings' Update all acts on (useUpdateAll).
export function useOutdatedDevices(): KnownUpdates {
  const targets = useUpdateTargets();
  const states = useUpdaterStates(targets.map((target) => target.deviceId));
  return findOutdated(
    targets.map((target, index) => ({
      deviceId: target.deviceId,
      running: target.running,
      state: states[index],
    })),
  );
}

// Update every device in `outdated` (useOutdatedDevices) not already on
// its way, from one button: Settings' Update all and the update toast.
// Each is told to fetch the newest release and restart into it (the
// host's updater:update), which answers right away and leaves the rest
// to the device, so the button never waits on a download and a device
// finishes whatever becomes of this window. The peers go first and
// together: each answers before it starts (updater.ts), so a busy
// one's refusal comes back here. This machine goes last, and only once
// every peer took its update, since restarting this window would end
// the page that reports a refusal and hold the retry. Its own install
// is attended, so a busy machine still gets the usual dialog.
// `updating` holds from the press until no device behind is left to
// ask: each one's state says it is on its way (`updating`) before its
// answer lands, and it drops out of `outdated` as it restarts.
export function useUpdateAll(
  outdated: Readonly<Record<string, OutdatedDevice>>,
) {
  const localDeviceId = useApi().deviceId;
  const targets = useUpdateTargets();

  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state push is the single source of truth, and the updater state atom follows it
  const mutation = useMutation({
    mutationFn: async () => {
      const chosen = targets.filter(
        (target) => outdated[target.deviceId]?.updating === false,
      );
      const local = chosen.find((target) => target.deviceId === localDeviceId);
      const refused = (
        await Promise.all(
          chosen
            .filter((target) => target !== local)
            .map((target) =>
              restartIntoUpdate(target.api, "update").then(
                () => [],
                (error: unknown) => [
                  `${target.label}: ${errorMessageOf(error).replace(/([^.!?])$/, "$1.")}`,
                ],
              ),
            ),
        )
      ).flat();
      if (refused.length > 0) {
        const reasons = refused.join(" ");
        throw new Error(
          local === undefined
            ? reasons
            : `${reasons} This device wasn't updated, so you can try again.`,
        );
      }
      if (local !== undefined) await restartIntoUpdate(local.api, "update");
    },
    meta: { errorTitle: "Couldn't update every device" },
  });
  return {
    update: () => mutation.mutate(),
    updating: mutation.isPending || allUpdating(outdated),
  };
}
