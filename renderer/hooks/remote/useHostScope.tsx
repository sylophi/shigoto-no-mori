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
//   renderer/boot.tsx, the worktree lifecycle events): main emits
//   this machine's events, so those watchers subscribe via window.api
//   and invalidate the local `queryKeys` registry explicitly. A
//   remote:true host broadcast mirrored for every device
//   (updater:state) follows the same split at boot scope: boot.tsx
//   for the local machine, lib/remote/remoteHostWatch.ts for the peers.
// - Host-scoped hooks whose write path is deliberately local-only
//   (the updateLocalGlobalConfig caller in useSettingsSave): the write
//   lands on this machine's disk, so their reads and invalidations
//   must stay pinned to the local `queryKeys` registry.
import { hasLocalHost } from "@/lib/localHost";
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
// rejecting at runtime on a remote device. test/host-boundary.mjs
// keeps this list equal to the host namespaces buildApi exposes.
export type HostApi = Pick<
  RemoteDeviceApi,
  | "branches"
  | "cli"
  | "device"
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
  | "sharedSettings"
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
  // True when there is a host behind the scope at all: a remote device
  // always, the local scope only on the desktop. A hostless client (the
  // web shell) has a local scope with nothing to answer host reads, so
  // the hooks that read one gate on this instead of asking and being
  // refused.
  hasHost: boolean;
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
  hasHost: hasLocalHost,
  api: window.api,
  keys: queryKeys,
};

const HostScopeContext = createContext<HostScope>(localHostScope);

// A device's scope, the one shape both providers below hand down.
function hostScopeFor(deviceId: string, api: HostApi): HostScope {
  const remote = deviceId !== localDeviceId;
  return {
    deviceId,
    remote,
    hasHost: remote || hasLocalHost,
    api,
    keys: queryKeysFor(deviceId),
  };
}

export function HostScopeProvider({
  deviceId,
  api,
  children,
}: Omit<HostScope, "keys" | "remote" | "hasHost"> & {
  children: ReactNode;
}) {
  return (
    <HostScopeContext value={hostScopeFor(deviceId, api)}>
      {children}
    </HostScopeContext>
  );
}

// Scopes a subtree to a device only when there is a session to scope
// it to: a peer with an api gets the provider, this machine (whose api
// is window.api, the default scope) and a peer that is asleep render
// the children where they are. The seam the sidebar's per-device
// actions and menus mount through.
export function MaybeHostScope({
  deviceId,
  api,
  children,
}: {
  deviceId: string;
  api: HostApi | undefined;
  children: ReactNode;
}) {
  if (api === undefined || deviceId === localDeviceId) return children;
  return (
    <HostScopeProvider deviceId={deviceId} api={api}>
      {children}
    </HostScopeProvider>
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

// The destination half of a cross-device flow, for the dialogs that
// serve both directions. A transplant or a mirror lands on this
// machine, so with no provider mounted this is LocalHostScope. A
// flow to a peer mounts DestinationProvider around its dialog, and
// every destination read beneath (the project's config, its
// carry-over, its branches and paths) goes to that peer instead. The
// peer is absent until the dialog's destination is picked. The
// provider is mounted either way, so picking re-scopes the subtree
// without remounting it, and nothing beneath reads a destination
// before there is one.
const DestinationContext = createContext<HostScope>(localHostScope);

export function DestinationProvider({
  peer,
  children,
}: {
  peer: Pick<HostScope, "deviceId" | "api"> | null;
  children: ReactNode;
}) {
  return (
    <DestinationContext
      value={
        peer === null ? localHostScope : hostScopeFor(peer.deviceId, peer.api)
      }
    >
      {children}
    </DestinationContext>
  );
}

// The destination as it stands, for a piece that names it (the pull
// flow's two ends) without re-pinning a subtree to it.
export function useDestinationScope(): HostScope {
  return use(DestinationContext);
}

export function DestinationScope({ children }: { children: ReactNode }) {
  return (
    <HostScopeContext value={use(DestinationContext)}>
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
