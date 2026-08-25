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

// Account status: configured/signedIn plus this device's stored name. It
// reads local state only and is cheap, so it is always enabled.
export function useAccountStatus() {
  return useQuery<AccountStatus>({
    queryKey: queryKeys.accountStatus(),
    queryFn: () => window.api.account.status(),
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

// The mutations do not invalidate on success themselves. Every sign-in,
// sign-out and rename ends with main emitting the account.changed
// broadcast, and useWatchAccountChanges invalidates the whole "account"
// prefix off that reliable local IPC, so a per-mutation invalidation
// would only duplicate it.
export function useSignIn() {
  return useMutation<AccountStatus, Error, void>({
    mutationFn: () => window.api.account.signIn(),
    meta: { errorTitle: "Couldn't sign in" },
  });
}

export function useSignOut() {
  return useMutation<void, Error, void>({
    mutationFn: () => window.api.account.signOut(),
    meta: { errorTitle: "Couldn't sign out" },
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

// Grant and revoke are imperative writes matching the account and
// hosting sections. They do not invalidate themselves: main emits
// grantsChanged and useWatchGrantsChanges invalidates off it.
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
