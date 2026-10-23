import { callOf } from "@shigomori/contracts/contract";
import { updaterContract } from "@shigomori/contracts/modules/updater";
import { useMutation } from "@tanstack/react-query";
import * as Atom from "effect/reactivity/Atom";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { useHostDevices } from "@/hooks/remote/useRemoteDevices";
import { useHasLocalHost } from "@/lib/localHost";
import {
  findOutdated,
  type KnownUpdates,
  type OutdatedDevice,
  restartIntoUpdate,
} from "@/lib/updates";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import { toast } from "@/lib/toast";
import { hostStateAtom } from "@/lib/runtime/atoms";
import { useApi } from "@/lib/runtime/pageApi";
import { useView, useViews, viewsOf } from "@/lib/runtime/viewHooks";

// One device's updater state, as its host pushes it on every change,
// seeded by its read (pushedState). A peer's starts again on each new
// session to it, which covers its restart into the new build.
const updaterStateAtom = Atom.family((deviceId: string) =>
  hostStateAtom(deviceId, {
    read: callOf(updaterContract, "get"),
    push: callOf(updaterContract, "state"),
  }).pipe(Atom.setIdleTTL("1 minute")),
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
  const reachable = useHostDevices().filter(
    (peer) => deviceStatusView(peer.status).reachable,
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
      peer.api !== undefined &&
      commandAccessOf(localDeviceId, peer.deviceId, peer).granted
        ? [
            {
              deviceId: peer.deviceId,
              label: peer.label,
              api: peer.api,
              running: peer.appVersion,
            },
          ]
        : [],
    ),
  ];
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

// Update every device in `outdated` (useOutdatedDevices), from one
// button: Settings' Update all and the update toast. A device with its
// update staged restarts into it. One without is told to fetch it and
// restart once it's staged (the host's updater:update), which answers
// right away, so the button never waits on a download. The peers go
// first and together: each answers before it quits or arms
// (updater.ts), so a busy one's refusal comes back here. This machine
// goes last, and only once every peer took its update, since
// restarting this window would end the page that reports a refusal and
// hold the retry. Its own install is attended, so a busy machine still
// gets the usual dialog. Resolves with the devices left downloading,
// by how they will finish (updateDevice).
export function useUpdateAll(
  outdated: Readonly<Record<string, OutdatedDevice>>,
) {
  const localDeviceId = useApi().deviceId;
  const targets = useUpdateTargets();

  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state push is the single source of truth, and the updater state atom follows it
  return useMutation({
    mutationFn: async () => {
      const chosen = targets.flatMap((target) => {
        const device = outdated[target.deviceId];
        return device === undefined ? [] : [{ target, device }];
      });
      const local = chosen.find(
        ({ target }) => target.deviceId === localDeviceId,
      );
      const outcomes = await Promise.all(
        chosen
          .filter((entry) => entry !== local)
          .map(({ target, device }) =>
            updateDevice(target, device).then(
              (outcome) => ({ label: target.label, outcome }),
              (error: unknown) => ({
                label: target.label,
                refusal: errorMessageOf(error).replace(/([^.!?])$/, "$1."),
              }),
            ),
          ),
      );
      const refused = outcomes.flatMap((entry) =>
        "refusal" in entry ? [`${entry.label}: ${entry.refusal}`] : [],
      );
      if (refused.length > 0) {
        const reasons = refused.join(" ");
        throw new Error(
          local === undefined
            ? reasons
            : `${reasons} This device was not updated, so you can try again.`,
        );
      }
      if (local !== undefined) {
        outcomes.push({
          label: local.target.label,
          outcome: await updateDevice(local.target, local.device),
        });
      }
      const labelsOf = (wanted: UpdateOutcome) =>
        outcomes.flatMap((entry) =>
          "outcome" in entry && entry.outcome === wanted ? [entry.label] : [],
        );
      return { armed: labelsOf("armed") };
    },
    onSuccess: ({ armed }) => {
      if (armed.length > 0) {
        toast.success(
          `${sentenceStart(names.format(armed))} ${
            armed.length === 1
              ? "restarts once its update downloads"
              : "restart once their updates download"
          }`,
        );
      }
    },
    meta: { errorTitle: "Couldn't update every device" },
  });
}

// How a device took its update: restarting into the staged one, or
// armed to restart once it has fetched it.
type UpdateOutcome = "installed" | "armed";

async function updateDevice(
  target: UpdateTarget,
  device: OutdatedDevice,
): Promise<UpdateOutcome> {
  if (device.staged) {
    await restartIntoUpdate(target.api);
    return "installed";
  }
  // One whose update reached it meanwhile restarts into it now.
  await restartIntoUpdate(target.api, "update");
  return "armed";
}

// "this device and MacBook" as the start of a sentence.
function sentenceStart(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const names = new Intl.ListFormat("en", { type: "conjunction" });
