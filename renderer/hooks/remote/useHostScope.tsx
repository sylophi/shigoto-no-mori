// The device-scope seam for the host-scoped data layer. Every
// host-scoped hook reads WHICH device it talks to — the api its
// queryFns and mutationFns call, and the key registry its queries
// cache under — from this context instead of hard-wiring window.api.
// With no provider mounted the context resolves to the local device,
// so the hooks behave identically outside a provider.
//
// Three categories deliberately do NOT route through here:
// - Client-scoped calls (dialog, shell, menu, nav, window, updater,
//   account, relay, clientConfig, projectLauncher): they belong to the
//   machine the window runs on, so their call sites keep window.api
//   and HostApi excludes them.
// - Broadcast subscriptions: main only emits this machine's events, so
//   watchers subscribe via window.api and invalidate with the local
//   `queryKeys` registry explicitly; scoped invalidations stay limited
//   to keys the hooks' own queries and mutations settle.
// - Host-scoped hooks whose write path is deliberately local-only
//   (the updateLocalGlobalConfig callers in useSettingsSave and
//   useLocalGlobalConfigUpdate, the cli module behind CliSection):
//   the write lands on this machine's disk, so their reads and
//   invalidations must stay pinned to the local `queryKeys` registry.
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
  | "fs"
  | "git"
  | "githubCli"
  | "globalConfig"
  | "hygiene"
  | "launchers"
  | "packageScripts"
  | "portPool"
  | "projects"
  | "remoteAccess"
  | "runtime"
  | "scripts"
  | "shigomori"
  | "sync"
  | "worktreeData"
  | "worktrees"
>;

export interface HostScope {
  // The device whose data the subtree reads and mutates.
  deviceId: string;
  // The api those calls go through: window.api locally, a connected
  // remote device's socket- or relay-backed api under a provider.
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
  api: window.api,
  keys: queryKeys,
};

const HostScopeContext = createContext<HostScope>(localHostScope);

export function HostScopeProvider({
  deviceId,
  api,
  children,
}: Omit<HostScope, "keys"> & { children: ReactNode }) {
  return (
    <HostScopeContext value={{ deviceId, api, keys: queryKeysFor(deviceId) }}>
      {children}
    </HostScopeContext>
  );
}

// No null check: the context always resolves (to the local device when
// no provider wraps the caller), so converting a host-scoped hook to
// read its scope from here must not change its local behavior.
export function useHostScope(): HostScope {
  return use(HostScopeContext);
}
