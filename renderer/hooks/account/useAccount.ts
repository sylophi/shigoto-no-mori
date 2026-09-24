// The renderer's view of the hub account layer:
// status, the account's device registry, and the sign-in / sign-out /
// rename mutations. All client-scoped, so the queries key off the plain
// "account" prefix (no host sentinel, see queryKeys.ts) and the changed
// broadcast invalidates the whole prefix at once.
import { useEffect } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AccountStatus } from "@shared/ipc/modules/account";
import type { DeviceInfo } from "@shared/hub/protocol";
import {
  MACHINE_FALLBACK_ICON,
  type DeviceIcon,
} from "@shared/account/deviceIcon";
import { hasLocalHost } from "@/lib/localHost";
import { queryKeys } from "@/lib/queryKeys";

// Account status: configured/signedIn plus this device's stored name.
// staleTime Infinity: `configured` is launch env and cannot change
// in-process, and signedIn/deviceName only change through flows that
// emit account:changed, which useWatchAccountChanges (always mounted
// in AppShell) turns into an invalidation. Without the opt-out, an
// observer in an always-mounted component would re-run the read (a main-process credential-file read
// plus keychain decrypt) on every window focus.
export function useAccountStatus() {
  return useQuery<AccountStatus>({
    queryKey: queryKeys.accountStatus(),
    queryFn: () => window.api.account.status(),
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
export const accountDevicesQueryOptions = queryOptions<DeviceInfo[]>({
  queryKey: queryKeys.accountDevices(),
  queryFn: () => window.api.account.listDevices(),
  // The registry renders the failure inline (DeviceRegistry), so no
  // toast on top.
  meta: { silentError: true },
});

// Both of this hook's call sites render only under a signed-in guard,
// so a signed-out or unconfigured app never mounts it and never hits
// the network. The handler returns [] in those states anyway, which is
// also all the device sync's own read of the entry can get.
export function useAccountDevices() {
  return useQuery(accountDevicesQueryOptions);
}

// Re-read status and the device list whenever main fans out a change
// (any sign-in, sign-out or rename), so every window stays in sync
// without polling. The subscribe call returns its own unsubscribe.
export function useWatchAccountChanges(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.account.onChanged(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.account() });
        // A departure drops the peer-keyed client config picks on
        // disk (main's fan-out, before this broadcast). The cached
        // copy must follow, or the next write here puts them back.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.clientConfig(),
        });
      }),
    [queryClient],
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
export function useEnroll() {
  return useMutation<AccountStatus, Error, () => Promise<string | null>>({
    mutationFn: async (mintToken) => {
      const token = await mintToken();
      if (!token) throw new Error("Clerk returned no session token");
      return window.api.account.enroll(token);
    },
    meta: { errorTitle: "Couldn't enroll this device" },
  });
}

// The account layer's half of sign-out (best-effort hub revoke plus
// local credential clear). ClerkAccountSync drives it when the Clerk
// session ends, while the UI buttons go through useClerkSignOut, which ends
// the Clerk session first and then this same IPC call.
export function useAccountSignOut() {
  return useMutation<void, Error, void>({
    mutationFn: () => window.api.account.signOut(),
    meta: { errorTitle: "Couldn't sign out" },
  });
}

// Removes another device from the account on the device hub. Like the
// command-access write it does not invalidate itself: main broadcasts
// account:changed after the revoke, and the watcher above turns it
// into the invalidation. Self-revoke is not
// offered by the devices page -- this device signs out instead, so the
// Clerk session ends first and ClerkAccountSync cannot re-enroll it
// back onto the account.
export function useRevokeDevice() {
  return useMutation<void, Error, string>({
    mutationFn: (deviceId) => window.api.account.revokeDevice(deviceId),
    meta: { errorTitle: "Couldn't remove this device" },
  });
}

// A rename of any device of the account, this one or a peer.
export function useSetDeviceName() {
  return useMutation<AccountStatus, Error, { deviceId: string; name: string }>({
    mutationFn: (target) => window.api.account.setDeviceName(target),
    meta: { errorTitle: "Couldn't rename the device" },
  });
}

// The icon pick for any device of the account, this one or a peer.
// Picking a device's detected icon puts it back to its default.
export function useSetDeviceIcon() {
  return useMutation<
    AccountStatus,
    Error,
    { deviceId: string; icon: DeviceIcon }
  >({
    mutationFn: (target) => window.api.account.setDeviceIcon(target),
    meta: { errorTitle: "Couldn't change the device's icon" },
  });
}

// Whether this host accepts commands from the account's other devices,
// for the current account. Mounted only under the same signed-in guard
// as useAccountDevices, and the handler answers false signed out. Kept
// off the "account" prefix so the toggle invalidates only this.
export function useAcceptsCommands() {
  return useQuery<boolean>({
    queryKey: queryKeys.accountCommandAccess(),
    queryFn: () => window.api.account.acceptsCommands(),
    meta: { errorTitle: "Couldn't read command access" },
  });
}

// Invalidate the command-access query whenever main fans out a flip,
// so every window's toggle reflects the new state without polling.
// Separate from the account.changed watch so the toggle never re-reads
// status or the device list.
export function useWatchCommandAccessChanges(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.account.onCommandAccessChanged(() => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.accountCommandAccess(),
        });
      }),
    [queryClient],
  );
}

// An imperative write. It does not invalidate itself: main emits
// commandAccessChanged and useWatchCommandAccessChanges invalidates
// off it.
export function useSetAcceptsCommands() {
  return useMutation<void, Error, boolean>({
    mutationFn: (enabled) => window.api.account.setAcceptsCommands(enabled),
    meta: { errorTitle: "Couldn't change command access" },
  });
}
