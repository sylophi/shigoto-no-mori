// The renderer's view of the hub account layer (v2 step 4, slice B):
// status, the account's device registry, and the sign-in / sign-out /
// rename mutations. All client-scoped, so the queries key off the plain
// "account" prefix (no host sentinel, see queryKeys.ts) and the changed
// broadcast invalidates the whole prefix at once.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountStatus } from "@shared/ipc/modules/account";
import type { DeviceInfo } from "@shared/hub/protocol";
import { queryKeys } from "@/lib/queryKeys";

// Account status: configured/signedIn plus this device's stored name.
// staleTime Infinity: `configured` is launch env and cannot change
// in-process, and signedIn/deviceName only change through flows that
// emit account:changed, which useWatchAccountChanges (always mounted,
// SidebarFooter on desktop and WebShell on web) turns into an
// invalidation. Without the opt-out, an observer in an always-mounted
// component would re-run the read (a main-process credential-file read
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

// The account's device registry from the device hub. Both call sites
// render only under a signed-in guard, so a signed-out or unconfigured
// app never mounts this and never hits the network (and the handler
// returns [] in those states anyway).
export function useAccountDevices() {
  return useQuery<DeviceInfo[]>({
    queryKey: queryKeys.accountDevices(),
    queryFn: () => window.api.account.listDevices(),
    meta: { errorTitle: "Couldn't load account devices" },
  });
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

export function useSetDeviceName() {
  return useMutation<AccountStatus, Error, string>({
    mutationFn: (name) => window.api.account.setDeviceName(name),
    meta: { errorTitle: "Couldn't rename this device" },
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
