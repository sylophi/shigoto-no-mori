// The renderer's view of the relay account layer (v2 step 4, slice B):
// status, the account's device registry, and the sign-in / sign-out /
// rename mutations. All client-scoped, so the queries key off the plain
// "account" prefix (no host sentinel, see queryKeys.ts) and the changed
// broadcast invalidates the whole prefix at once.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountStatus } from "@shared/ipc/modules/account";
import type { DeviceInfo } from "@shared/relay/protocol";
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

// The account's device registry from the relay. Enabled only when signed
// in so a signed-out or unconfigured app never hits the network. The
// handler already returns [] in those states, and gating here keeps the
// query from firing at all.
export function useAccountDevices(enabled: boolean) {
  return useQuery<DeviceInfo[]>({
    queryKey: queryKeys.accountDevices(),
    queryFn: () => window.api.account.listDevices(),
    enabled,
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
// Exchanges a fresh Clerk session token for the relay device
// credential. Driven by ClerkAccountSync after Clerk reports a
// session; the Clerk sign-in UI itself never touches this layer.
export function useEnroll() {
  return useMutation<AccountStatus, Error, string>({
    mutationFn: (token) => window.api.account.enroll(token),
    meta: { errorTitle: "Couldn't enroll this device" },
  });
}

export function useSetDeviceName() {
  return useMutation<AccountStatus, Error, string>({
    mutationFn: (name) => window.api.account.setDeviceName(name),
    meta: { errorTitle: "Couldn't rename this device" },
  });
}

// The peer deviceIds this host grants command access, for the current
// account. Enabled only when signed in, mirroring useAccountDevices: the
// handler returns [] signed out, and gating keeps the query idle. Kept
// off the "account" prefix so a grant toggle invalidates only this.
export function useGrantedDevices(enabled: boolean) {
  return useQuery<string[]>({
    queryKey: queryKeys.accountGrantedDevices(),
    queryFn: () => window.api.account.listGrantedDevices(),
    enabled,
    meta: { errorTitle: "Couldn't load command grants" },
  });
}

// Invalidate the granted-devices query whenever main fans out a grant
// change, so every window's per-device control reflects the new state
// without polling. Separate from the account.changed watch so a grant
// toggle never re-reads status or the device list.
export function useWatchGrantsChanges(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.account.onGrantsChanged(() => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.accountGrantedDevices(),
        });
      }),
    [queryClient],
  );
}

// Grant and revoke are imperative writes. They do not invalidate
// themselves: main emits grantsChanged and useWatchGrantsChanges
// invalidates off it.
export function useGrantCommands() {
  return useMutation<void, Error, string>({
    mutationFn: (deviceId) => window.api.account.grantCommands(deviceId),
    meta: { errorTitle: "Couldn't allow commands" },
  });
}

export function useRevokeCommands() {
  return useMutation<void, Error, string>({
    mutationFn: (deviceId) => window.api.account.revokeCommands(deviceId),
    meta: { errorTitle: "Couldn't revoke commands" },
  });
}
