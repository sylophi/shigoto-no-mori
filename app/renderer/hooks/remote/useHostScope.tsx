// The device-scope seam for the host-scoped data layer. Every
// host-scoped hook reads WHICH device it talks to (the api its
// queryFns and mutationFns call, and the key registry its queries
// cache under) from this context instead of hard-wiring the page's api.
// With no provider mounted the context resolves to the local device,
// so the hooks behave identically outside a provider.
//
// Two categories deliberately do NOT route through here:
// - Client-scoped calls (dialog, shell, menu, nav, window, account,
//   hub, clientConfig, portForward): they
//   belong to the machine the window runs on, so their call sites keep
//   the page's api (useApi) and HostApi excludes them.
// - Host broadcast subscriptions: they are boot-scoped, one watchHost
//   per device (lib/hostWatch.ts) over that device's api, writing into
//   that device's registry, so no scope is involved.
import type { HostApi } from "@/lib/runtime/Api";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createContext, use, useState, type ReactNode } from "react";
import {
  useDeviceReach,
  useRemoteDeviceLabel,
} from "@/hooks/remote/useDevices";
import { isLive, peerOf, remoteDeviceById } from "@/lib/remote/devices";
import { queryKeysFor, type QueryKeyRegistry } from "@/lib/queryKeys";
import { type RendererApi, useApi } from "@/lib/runtime/pageApi";

// The host-scoped api (lib/runtime/Api.ts), the one a scope's hooks
// reach: scope.api.dialog fails to compile rather than rejecting on a
// remote device.
export type { HostApi };

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
  // The api those calls go through: the page's locally, a connected
  // remote device's socket- or hub-backed api under a provider.
  api: HostApi;
  // The key registry the subtree's queries cache under, bound to
  // deviceId. Referentially stable per device (queryKeysFor memoizes),
  // so it is safe in dependency arrays.
  keys: QueryKeyRegistry;
}

// A device's scope over its api (the page's for this machine, a peer's
// off page.peerApi), one per device and page api, so the value is
// stable for the page's life.
const scopes = new WeakMap<RendererApi, Map<string, HostScope>>();

function scopeFor(page: RendererApi, deviceId: string): HostScope {
  let byDevice = scopes.get(page);
  if (byDevice === undefined) {
    byDevice = new Map();
    scopes.set(page, byDevice);
  }
  let scope = byDevice.get(deviceId);
  if (scope === undefined) {
    const remote = deviceId !== page.deviceId;
    scope = {
      deviceId,
      remote,
      hasHost: remote || page.isElectron,
      api: remote ? page.peerApi(deviceId) : page,
      keys: queryKeysFor(deviceId),
    };
    byDevice.set(deviceId, scope);
  }
  return scope;
}

// What every hook reads with no provider mounted.
const localHostScope = (page: RendererApi) => scopeFor(page, page.deviceId);

// Null where no provider wraps the caller: the local device's scope.
const HostScopeContext = createContext<HostScope | null>(null);

// A device's scope, the one shape both providers below hand down.
function hostScopeFor(
  page: RendererApi,
  deviceId: string,
  api: HostApi,
): HostScope {
  const remote = deviceId !== page.deviceId;
  return {
    deviceId,
    remote,
    hasHost: remote || page.isElectron,
    api,
    keys: queryKeysFor(deviceId),
  };
}

// Any device's scope by id, for a caller outside React (the villager
// toasts, lib/villagers/moves.ts): this machine's, or a peer's while
// it can be asked. Undefined for a peer that can't.
export function hostScopeOf(
  page: RendererApi,
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
): HostScope | undefined {
  if (deviceId === page.deviceId) return localHostScope(page);
  const peer = remoteDeviceById(registry, deviceId);
  return peer !== undefined && isLive(peerOf(page, peer))
    ? scopeFor(page, deviceId)
    : undefined;
}

// Scopes a subtree to a device. With `absent`, the subtree shows once
// the device can be asked and stays through a blip after that, so what
// sits under it (a seeded form and its unsaved edits, a scrolled diff)
// outlives the blip: its requests fail meanwhile, and its cache
// refetches as the session lands. A device that never could be asked
// while this was mounted, that stopped sharing or that left the list
// gets `absent` in its place. Without `absent`, the subtree shows
// whatever the device's state.
export function DeviceScope({
  deviceId,
  absent,
  children,
}: {
  deviceId: string;
  absent?: ReactNode;
  children: ReactNode;
}) {
  const page = useApi();
  const reach = useDeviceReach(deviceId);
  const live = reach.kind === "this" || reach.kind === "live";
  const [shownId, setShownId] = useState(live ? deviceId : undefined);
  const nextShownId = live
    ? deviceId
    : reach.kind === "gone"
      ? undefined
      : shownId;
  if (nextShownId !== shownId) setShownId(nextShownId);
  const kept = nextShownId === deviceId && reach.kind !== "notSharing";
  if (absent !== undefined && !kept) return absent;
  return (
    <HostScopeContext value={scopeFor(page, deviceId)}>
      {children}
    </HostScopeContext>
  );
}

export function HostScopeProvider({
  deviceId,
  api,
  children,
}: Omit<HostScope, "keys" | "remote" | "hasHost"> & {
  children: ReactNode;
}) {
  return (
    <HostScopeContext value={hostScopeFor(useApi(), deviceId, api)}>
      {children}
    </HostScopeContext>
  );
}

// Scopes a subtree to a device only when there is a session to scope
// it to: a peer with an api gets the provider, this machine (whose api
// is the page's, the default scope) and a peer that is asleep render
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
  const localDeviceId = useApi().deviceId;
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
// paths). The same value the provider-less default resolves to, so
// it is stable and the hooks beneath behave exactly as they do on a
// local page.
export function LocalHostScope({ children }: { children: ReactNode }) {
  return (
    <HostScopeContext value={localHostScope(useApi())}>
      {children}
    </HostScopeContext>
  );
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
const DestinationContext = createContext<HostScope | null>(null);

export function DestinationProvider({
  peer,
  children,
}: {
  peer: Pick<HostScope, "deviceId" | "api"> | null;
  children: ReactNode;
}) {
  const page = useApi();
  return (
    <DestinationContext
      value={
        peer === null
          ? localHostScope(page)
          : hostScopeFor(page, peer.deviceId, peer.api)
      }
    >
      {children}
    </DestinationContext>
  );
}

// The destination as it stands, for a piece that names it (the pull
// flow's two ends) without re-pinning a subtree to it.
export function useDestinationScope(): HostScope {
  const page = useApi();
  return use(DestinationContext) ?? localHostScope(page);
}

export function DestinationScope({ children }: { children: ReactNode }) {
  return (
    <HostScopeContext value={useDestinationScope()}>
      {children}
    </HostScopeContext>
  );
}

// Always a scope: the local device's when no provider wraps the
// caller, so converting a host-scoped hook to read its scope from here
// must not change its local behavior.
export function useHostScope(): HostScope {
  const page = useApi();
  return use(HostScopeContext) ?? localHostScope(page);
}

// The name of the device the caller's scope reads, for prose.
export function useScopedDeviceLabel(): string {
  return useRemoteDeviceLabel(useHostScope().deviceId);
}
