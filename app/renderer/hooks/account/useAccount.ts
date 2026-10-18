// The renderer's view of the hub account layer:
// status, the account's device registry, and the sign-in / sign-out /
// rename mutations. All client-scoped, so the queries key off the plain
// "account" prefix (no host sentinel, see queryKeys.ts) and the changed
// broadcast invalidates the whole prefix at once.
import { refreshQueries } from "@/lib/askAgain";
import {
  type HubRateLimitedError,
  isHubRateLimitedError,
} from "@shigomori/contracts/errors";
import { useEffect } from "react";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  accountContract,
  type AccountStatus,
} from "@shigomori/contracts/modules/account";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import {
  MACHINE_FALLBACK_ICON,
  type DeviceIcon,
} from "@shigomori/contracts/deviceIcon";
import { type Deadline, deadlineIn, deadlinePassed } from "@/lib/deadline";
import { useHasLocalHost } from "@/lib/localHost";
import { queryKeys } from "@/lib/queryKeys";
import { type RendererApi, useApi } from "@/lib/runtime/pageApi";
import { callOf } from "@shigomori/contracts/contract";
import * as Atom from "effect/reactivity/Atom";
import { clientAtoms, shellState } from "@/lib/runtime/atoms";
import {
  useRegistry,
  useView,
  useViewErrorToast,
} from "@/lib/runtime/viewHooks";

// Account status: configured/signedIn plus this device's stored name.
// staleTime Infinity: `configured` is launch env and cannot change
// in-process, and signedIn/deviceName only change through flows that
// emit account:changed, which useWatchAccountChanges (always mounted
// in AppShell) turns into an invalidation. Without the opt-out, an
// observer in an always-mounted component would re-run the read (a main-process credential-file read
// plus keychain decrypt) on every window focus.
export function useAccountStatus() {
  const api = useApi();
  return useQuery<AccountStatus>({
    queryKey: queryKeys.accountStatus(),
    queryFn: ({ signal }) => api.run(api.account.status(), { signal }),
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't read account status" },
  });
}

// This device's display name: its account name, or a neutral fallback
// while signed out (or while a cleared name is empty). One rule so the
// Settings sidebar, its header and the new-worktree picker agree.
export function useLocalDeviceName(): string {
  const { data: account } = useAccountStatus();
  return account?.deviceName || "This device";
}

// Both at once, for the surfaces that draw this device's name beside
// its glyph.
export function useLocalDevice(): { name: string; icon: DeviceIcon } {
  return { name: useLocalDeviceName(), icon: useLocalDeviceIcon() };
}

// What this device looks like, for its own marks: the account's
// answer, or the platform's fallback until the status lands (a
// desktop app is a machine, a hostless client a browser), so a mark
// never waits on the read.
export function useLocalDeviceIcon(): DeviceIcon {
  const hasLocalHost = useHasLocalHost();
  const { data: account } = useAccountStatus();
  return (
    account?.deviceIcon ?? (hasLocalHost ? MACHINE_FALLBACK_ICON : "browser")
  );
}

// The account's device registry from the device hub, as shared options
// rather than a hook body alone: this cache entry is the renderer's ONE
// copy of the list. The remote device sync rebuilds its store off the
// very same entry (renderer/lib/remote/remoteDeviceSync.ts), so a
// refetch here (a mount, a window focus, any invalidation) heals the
// sidebar's badges and the device tabs too. A second copy alongside it
// could only ever be corrected by this process's own account:changed
// fan-out, which says nothing about a peer renaming itself or being
// removed from the account elsewhere: the hub pushes neither.
// A read the hub's rate limiter turned away is not asked again until the
// hub's Retry-After has passed, whoever asks (a page, a push burst, the
// device sync): each ask in that window would only draw another 429.
// Kept per client, since a fetch of a query with no data clears its
// error as it starts.
const listRefusals = new WeakMap<
  QueryClient,
  { readonly until: Deadline; readonly error: HubRateLimitedError }
>();

export const accountDevicesQueryOptions = (api: RendererApi) =>
  queryOptions<readonly DeviceInfo[]>({
    queryKey: queryKeys.accountDevices(),
    queryFn: async ({ signal, client }) => {
      const refused = listRefusals.get(client);
      if (refused !== undefined && !deadlinePassed(refused.until)) {
        throw refused.error;
      }
      try {
        return await api.run(api.account.listDevices(), { signal });
      } catch (error) {
        if (isHubRateLimitedError(error)) {
          listRefusals.set(client, {
            until: deadlineIn((error.retryAfterSeconds ?? 0) * 1000),
            error,
          });
        }
        throw error;
      }
    },
    // The registry renders the failure inline (DeviceRegistry), so no
    // toast on top.
    meta: { silentError: true },
  });

// Both of this hook's call sites render only under a signed-in guard,
// so a signed-out or unconfigured app never mounts it and never hits
// the network. The handler returns [] in those states anyway, which is
// also all the device sync's own read of the entry can get.
export function useAccountDevices() {
  return useQuery(accountDevicesQueryOptions(useApi()));
}

// Re-read status and the device list whenever main fans out a change
// (any sign-in, sign-out or rename), so every window stays in sync
// without polling. The subscribe call returns its own unsubscribe.
export function useWatchAccountChanges(): void {
  const api = useApi();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      api.listen(api.pushes(accountContract, "changed"), () => {
        refreshQueries(queryClient, { queryKey: queryKeys.account() });
      }),
    [queryClient, api],
  );
}

// The mutations do not invalidate on success themselves. Every
// enrollment, sign-out and rename ends with the account.changed
// broadcast, and useWatchAccountChanges invalidates the whole "account"
// prefix off that reliable local IPC, so a per-mutation invalidation
// would only duplicate it.
// Exchanges a fresh Clerk session token for the hub device
// credential. Driven by ClerkAccountSync after Clerk reports a
// session. The Clerk sign-in UI itself never touches this layer.
// Takes the token mint as a callback so a failed mint lands in the
// same error path (and toast) as a failed enrollment.
// Every enrollment's key, so a reader can see one running anywhere
// (useDeviceKeyStep).
export const ENROLL_MUTATION_KEY = ["account", "enroll"];

export function useEnroll() {
  const api = useApi();
  return useMutation<AccountStatus, Error, () => Promise<string | null>>({
    mutationKey: ENROLL_MUTATION_KEY,
    mutationFn: async (mintToken) => {
      const token = await mintToken();
      if (!token) throw new Error("Clerk returned no session token");
      return api.run(api.account.enroll(token));
    },
    meta: { errorTitle: "Couldn't enroll this device" },
  });
}

// The account layer's half of sign-out (best-effort hub revoke plus
// local credential clear). ClerkAccountSync drives it when the Clerk
// session ends, while the UI buttons go through useClerkSignOut, which ends
// the Clerk session first and then this same IPC call.
export function useAccountSignOut() {
  const api = useApi();
  return useMutation<void, Error, void>({
    mutationFn: () => api.run(api.account.signOut()),
    meta: { errorTitle: "Couldn't sign out" },
  });
}

// Removes another device from the account on the device hub. It does
// not invalidate itself: main broadcasts account:changed after the
// revoke, and the watcher above turns it into the invalidation. Self-revoke is not
// offered by the account page -- this device signs out instead, so the
// Clerk session ends first and ClerkAccountSync cannot re-enroll it
// back onto the account.
export function useRevokeDevice() {
  const api = useApi();
  return useMutation<void, Error, string>({
    mutationFn: (deviceId) => api.run(api.account.revokeDevice(deviceId)),
    meta: { errorTitle: "Couldn't remove this device" },
  });
}

// A rename of any device of the account, this one or a peer.
export function useSetDeviceName() {
  const api = useApi();
  return useMutation<AccountStatus, Error, { deviceId: string; name: string }>({
    mutationFn: (target) => api.run(api.account.setDeviceName(target)),
    meta: { errorTitle: "Couldn't rename the device" },
  });
}

// The icon pick for any device of the account, this one or a peer.
// Picking a device's detected icon puts it back to its default.
export function useSetDeviceIcon() {
  const api = useApi();
  return useMutation<
    AccountStatus,
    Error,
    { deviceId: string; icon: DeviceIcon }
  >({
    mutationFn: (target) => api.run(api.account.setDeviceIcon(target)),
    meta: { errorTitle: "Couldn't change the device's icon" },
  });
}

// Whether this host accepts commands from the account's other devices,
// for the current account, as the shell says it and pushes each flip
// (a change of account included). The handler answers false signed
// out.
const acceptsCommandsAtom = Atom.keepAlive(
  clientAtoms.atom(
    shellState(accountContract, {
      read: callOf(accountContract, "acceptsCommands"),
      push: callOf(accountContract, "commandAccessChanged"),
    }),
  ),
);

export function useAcceptsCommands() {
  const state = useView(acceptsCommandsAtom);
  useViewErrorToast(state, "Couldn't read command access");
  return { data: state.data, isError: state.error !== null };
}

// An imperative write: main emits commandAccessChanged, which the
// switch's atom follows.
export function useSetAcceptsCommands() {
  const api = useApi();
  const registry = useRegistry();
  return useMutation<void, Error, boolean>({
    mutationFn: (enabled) => api.run(api.account.setAcceptsCommands(enabled)),
    // The switch's read asked again, which a failed one needs (its
    // stream ended, so the flip's push is not heard).
    onSettled: () => registry.refresh(acceptsCommandsAtom),
    meta: { errorTitle: "Couldn't change command access" },
  });
}
