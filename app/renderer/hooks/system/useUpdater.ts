import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { errorMessageOf } from "@shared/errors";
import { noHandlerMessage } from "@shared/ipc/socket/frames";
import type { UpdaterState } from "@shared/schemas";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { useHostDevices } from "@/hooks/remote/useRemoteDevices";
import { hasLocalHost } from "@/lib/localHost";
import {
  findOutdated,
  type KnownUpdates,
  type OutdatedDevice,
} from "@/lib/updates";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { toast } from "@/lib/toast";
import { localDeviceId, queryKeysFor } from "@/lib/queryKeys";

// One device's updater state, under that device's own key. Errors stay
// silent: a peer out of reach answers nothing, and the Version section
// shows that as unavailable rather than toasting on every visit.
function updaterStateQueryOptions(deviceId: string, api: HostApi) {
  return queryOptions<UpdaterState>({
    queryKey: queryKeysFor(deviceId).updaterState(),
    queryFn: () => api.updater.get(),
    // Never stale: every device's updater:state broadcast is mirrored
    // into its key by its push watch (lib/hostWatch.ts), and a peer's
    // is re-read whenever its session lands, which covers a restart
    // into the new build.
    staleTime: Number.POSITIVE_INFINITY,
    // A focus has nothing to add to that, and an unreachable peer
    // (whose read never succeeds, so it is always stale) would
    // otherwise be re-asked, with retries, on every one.
    refetchOnWindowFocus: false,
    meta: { silentError: true },
  });
}

// The one writer both boot-scope mirrors go through. A push landing
// while the seeding read is still in flight would be overwritten by
// that read's older answer, for good under the staleTime above, so the
// read is dropped first: the push is the newer word.
export function writeUpdaterState(
  queryClient: QueryClient,
  deviceId: string,
  state: UpdaterState,
): void {
  const queryKey = queryKeysFor(deviceId).updaterState();
  void queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData(queryKey, state);
}

// Seeded from `updater:get` and then driven entirely by the
// `updater:state` broadcast, with no polling. The serving process is
// the single source of truth. The renderer just mirrors it, at boot
// scope rather than here (see the staleTime note above). Reads its
// device from the host scope: this window's own updater with no
// provider mounted, or a peer's over its direct session inside one,
// so the same Settings card answers for whichever device is selected.
export function useUpdater() {
  const { deviceId, api } = useHostScope();
  const query = useQuery(updaterStateQueryOptions(deviceId, api));

  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state broadcast is the single source of truth, and the boot-scope mirrors write each new state into the cache
  const check = useMutation({
    mutationFn: () => api.updater.check(),
    meta: { errorTitle: "Couldn't check for updates" },
  });
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state broadcast is the single source of truth, and the boot-scope mirrors write each new state into the cache
  const install = useMutation({
    mutationFn: () => api.updater.install(),
    meta: { errorTitle: "Couldn't install the update" },
  });

  // The explicit annotation strips react-query's NoInfer wrapper from
  // `data`; tsgo (TypeScript 7) can't narrow the discriminated union
  // through the intrinsic NoInfer that query-core 5.101 switched to.
  const state: UpdaterState | null = query.data ?? null;
  return {
    state,
    check,
    install,
    isError: query.isError,
    refetch: query.refetch,
  };
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
            api: window.api,
            running: __APP_VERSION__,
          },
        ]
      : []),
    ...reachable.flatMap((peer) =>
      peer.api !== undefined && commandAccessOf(peer.deviceId, peer).granted
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
// Settings dot, Settings' General row and its device tabs flag. A plain object so
// react-query can hand back the same reference while the answer is
// unchanged.
export function useStagedUpdates(): Readonly<Record<string, string>> {
  const targets = useUpdateTargets();
  return useQueries({
    queries: targets.map((target) =>
      updaterStateQueryOptions(target.deviceId, target.api),
    ),
    combine: (results) => {
      const staged: Record<string, string> = {};
      targets.forEach((target, index) => {
        const state: UpdaterState | undefined = results[index]?.data;
        if (state?.kind === "ready") staged[target.deviceId] = state.version;
      });
      return staged;
    },
  });
}

// Every device this window could update that is behind the newest
// release any of them has found (findOutdated). What the update toast
// offers and Settings' Update all acts on (useUpdateAll).
export function useOutdatedDevices(): KnownUpdates {
  const targets = useUpdateTargets();
  return useQueries({
    queries: targets.map((target) =>
      updaterStateQueryOptions(target.deviceId, target.api),
    ),
    combine: (results) =>
      findOutdated(
        targets.map((target, index) => ({
          deviceId: target.deviceId,
          running: target.running,
          state: results[index]?.data,
        })),
      ),
  });
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
  const targets = useUpdateTargets();

  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state broadcast is the single source of truth, and the boot-scope mirrors write each new state into the cache
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
      return { armed: labelsOf("armed"), fetching: labelsOf("fetching") };
    },
    onSuccess: ({ armed, fetching }) => {
      if (armed.length > 0) {
        toast.success(
          `${sentenceStart(names.format(armed))} ${
            armed.length === 1
              ? "restarts once its update downloads"
              : "restart once their updates download"
          }`,
        );
      }
      if (fetching.length > 0) {
        toast.success(
          `${sentenceStart(names.format(fetching))} ${
            fetching.length === 1 ? "is" : "are"
          } downloading the update. Restart from Settings once it's ready.`,
        );
      }
    },
    meta: { errorTitle: "Couldn't update every device" },
  });
}

// How a device took its update: restarting into the staged one, armed
// to restart once it has fetched it, or only fetching it.
type UpdateOutcome = "installed" | "armed" | "fetching";

// A staged update goes through install, which a peer on an older build
// answers too. One not staged yet is armed with updater:update, which a
// peer on a build from before it doesn't serve: that one is asked to
// fetch it instead (a check), and restarting stays a click in its
// Settings.
async function updateDevice(
  target: UpdateTarget,
  device: OutdatedDevice,
): Promise<UpdateOutcome> {
  if (device.staged) {
    await target.api.updater.install();
    return "installed";
  }
  try {
    await target.api.updater.update();
    return "armed";
  } catch (error) {
    if (!errorMessageOf(error).includes(noHandlerMessage("updater:update"))) {
      throw error;
    }
    await target.api.updater.check();
    return "fetching";
  }
}

// "this device and Thinkpad" as the start of a sentence.
function sentenceStart(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const names = new Intl.ListFormat("en", { type: "conjunction" });
