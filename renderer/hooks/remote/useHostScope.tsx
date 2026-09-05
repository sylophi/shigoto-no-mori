// The device-scope seam for the host-scoped data layer. Every
// host-scoped hook reads WHICH device it talks to — the api its
// queryFns and mutationFns call, and the key registry its queries
// cache under — from this context instead of hard-wiring window.api.
// With no provider mounted the context resolves to the local device,
// so the hooks behave identically outside a provider.
//
// Three categories deliberately do NOT route through here:
// - Client-scoped calls (dialog, shell, menu, nav, window, account,
//   hub, clientConfig, projectLauncher, portForward): they
//   belong to the machine the window runs on, so their call sites keep
//   window.api and HostApi excludes them.
// - Local broadcast subscriptions (the fs watcher's externalChange in
//   renderer/index.tsx, the worktree lifecycle events): main emits
//   this machine's events, so those watchers subscribe via window.api
//   and invalidate the local `queryKeys` registry explicitly. A hook
//   that mirrors a remote:true host broadcast for whichever device it
//   shows (useUpdater's updater:state) subscribes through scope.api
//   instead, which a peer's transport routes over its direct session.
// - Host-scoped hooks whose write path is deliberately local-only
//   (the updateLocalGlobalConfig caller in useSettingsSave, the cli
//   module behind CliSection): the write lands on this machine's disk,
//   so their reads and invalidations must stay pinned to the local
//   `queryKeys` registry.
import { createContext, use, type ReactNode } from "react";
import type { RemoteDeviceApi } from "@/lib/remote/devices";
import {
  localDeviceId,
  queryKeys,
  queryKeysFor,
  type QueryKeyRegistry,
} from "@/lib/queryKeys";

// The host-scoped slice of the api surface: exactly the namespaces
// whose contracts are defineContract("host", ...). window.api and a
// connected remote device's api both satisfy it, so one hook body
// serves both. Client-scoped namespaces are excluded on purpose: a
// hook that reaches for scope.api.dialog fails to compile instead of
// rejecting at runtime on a remote device. scripts/check-host-boundary
// keeps this list equal to the host namespaces buildApi exposes.
export type HostApi = Pick<
  RemoteDeviceApi,
  | "branches"
  | "cli"
  | "forward"
  | "fs"
  | "git"
  | "githubCli"
  | "globalConfig"
  | "hygiene"
  | "launchers"
  | "mirror"
  | "packageScripts"
  | "portPool"
  | "ports"
  | "projects"
  | "remoteAccess"
  | "runtime"
  | "scripts"
  | "shigomori"
  | "sync"
  | "terrier"
  | "updater"
  | "worktreeData"
  | "worktrees"
>;

export interface HostScope {
  // The device whose data the subtree reads and mutates.
  deviceId: string;
  // True when that device is another machine. Computed once here so the
  // affordances that are local by nature (launching, configure links)
  // gate on the scope instead of each re-deriving the comparison
  // against localDeviceId.
  remote: boolean;
  // The api those calls go through: window.api locally, a connected
  // remote device's socket- or hub-backed api under a provider.
  api: HostApi;
  // The key registry the subtree's queries cache under, bound to
  // deviceId. Referentially stable per device (queryKeysFor memoizes),
  // so it is safe in dependency arrays.
  keys: QueryKeyRegistry;
}

// Default is the local device, read synchronously off the preload
// bridge, so every hook works unchanged with no provider mounted.
const localHostScope: HostScope = {
  deviceId: localDeviceId,
  remote: false,
  api: window.api,
  keys: queryKeys,
};

const HostScopeContext = createContext<HostScope>(localHostScope);

export function HostScopeProvider({
  deviceId,
  api,
  children,
}: Omit<HostScope, "keys" | "remote"> & { children: ReactNode }) {
  return (
    <HostScopeContext
      value={{
        deviceId,
        remote: deviceId !== localDeviceId,
        api,
        keys: queryKeysFor(deviceId),
      }}
    >
      {children}
    </HostScopeContext>
  );
}

// Re-pins a subtree to THIS machine from inside a remote scope, for
// the half of a cross-device flow that belongs here (the transplant
// dialog's destination: its project config, carry-over and runtime
// paths). The same constant the provider-less default resolves to, so
// the value is stable and the hooks beneath behave exactly as they do
// on a local page.
export function LocalHostScope({ children }: { children: ReactNode }) {
  return <HostScopeContext value={localHostScope}>{children}</HostScopeContext>;
}

// No null check: the context always resolves (to the local device when
// no provider wraps the caller), so converting a host-scoped hook to
// read its scope from here must not change its local behavior.
export function useHostScope(): HostScope {
  return use(HostScopeContext);
}
