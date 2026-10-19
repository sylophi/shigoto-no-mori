// The browser binding's composition root: the web client is a device
// with no host of its own, so it reaches every
// host as a peer, over the device link through the hub (the direct
// plane below), and serves only itself, in the page: the client modules
// (clientConfig, account, hub, shell, releases) and its copy of the
// shared settings, on the tab's local registrar (localRegistrar.ts). It
// builds the SAME page api the desktop does: the scalar facts
// (deviceId, appVersion, isDev, isElectron) plus the clients over that
// registrar, on the tab's client runtime (renderer/lib/runtime), so
// renderer components mount unmodified.
//
// Every platform fact arrives through WebBridgeDeps rather than a
// browser global read at module scope, so the headless bridge check
// drives the whole factory under node with in-memory storage and a
// recording fetch.
import { createAccountService } from "@shared/account/service";
import { makeAccountHandlers } from "@shared/account/handlers";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ClientLinks } from "@/lib/runtime/ClientLinks";
import { startClientNow } from "@/lib/runtime/client";
import type { RendererApi } from "@/lib/runtime/pageApi";
import { accountContract } from "@shigomori/contracts/modules/account";
import { clientConfigContract } from "@shigomori/contracts/modules/clientConfig";
import {
  departed,
  withoutPeerState,
} from "@shigomori/contracts/schemas/config";
import { rotationOwner } from "@shigomori/ui/lib/themes.ts";
import { hubContract } from "@shigomori/contracts/modules/hub";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import { releasesContract } from "@shigomori/contracts/modules/releases";
import { shellContract } from "@shigomori/contracts/modules/shell";
import type { EffectHandlers, Handlers } from "@shigomori/contracts/types";
import { servedInvokePeer } from "@shared/hub/bridgeHandlers";
import * as DirectPlane from "@shared/hub/directPlane";
import type { HubConnection } from "@shared/hub/connection";
import { fetchReleases } from "@shared/releases";
import {
  type SharedSettingsDoc,
  SharedSettingsDocSchema,
  StoredClientConfigSchema,
} from "@shigomori/contracts/schemas";
import {
  createSharedSettingsCopy,
  EMPTY_SHARED_SETTINGS,
} from "@shigomori/contracts/sharedSettings";
import { WEB_PLATFORM } from "@shigomori/contracts/platform";
import { retryParkedRevoke } from "@shared/account/enroll";
import * as WebHub from "../hub/connection";
import { createHubTrace } from "../hub/trace";
import {
  isConfigured,
  resolveServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import { getWebDeviceId } from "../account/deviceId";
import { defaultWebDeviceName, type BrowserHints } from "../account/deviceName";
import { defaultWebDeviceShape } from "../account/deviceIcon";
import { createWebAccountStore } from "../account/store";
import { readJsonKey, writeKey, type KeyValueStorage } from "../lib/kvStorage";
import { createLocalRegistrar } from "./localRegistrar";

export type WebBridgeDeps = {
  // Persistent per-browser storage (window.localStorage in the real
  // client): the device id, the credential envelope and clientConfig.
  localStorage: KeyValueStorage;
  // The env record the account service config resolves from
  // (import.meta.env in the real client).
  env: Record<string, string | undefined>;
  // navigator.userAgent, for the default device name, plus the client
  // hints that name a Chromium fork the string cannot.
  userAgent: string;
  browserHints?: BrowserHints;
  // shell.openExternal's browser form (window.open with noopener).
  openExternal: (url: string) => void;
  isDev: boolean;
  appVersion: string;
  fetchImpl?: typeof fetch;
  // Test seam: the candidate kinds the tab dials. A browser page dials
  // the wss tunnel only (mixed content forbids ws:// under https), which
  // a proof cannot serve, so a proof dials the listener's lan candidate.
  dialableKinds?: ReadonlyArray<"lan" | "tunnel">;
};

export type WebBridge = {
  // The page's api (renderer/lib/runtime/pageApi.tsx).
  api: RendererApi;
  // The tab's links, for the boot's atoms.
  links: ClientLinks["Service"];
  // Cross-tab correction: another tab changed the persisted account
  // (a storage event); re-read and fan out exactly like a local
  // transition. The storage event itself only fires in OTHER tabs, so
  // the tab's own push and this never double-fire.
  notifyAccountChanged(): void;
  // The same for the client config another tab wrote.
  notifyClientConfigChanged(): void;
  // Reconciles the hub socket with the current account state.
  refreshHub(): Promise<void>;
  // The liveness probe for the hub socket and every direct session,
  // fired by the install when the page comes back to the foreground
  // or the browser reports the network gone or back: a socket that
  // died while the tab was hidden or offline is found and redialed in
  // seconds instead of the sidebar reading "Connected" off a corpse
  // until the next heartbeat tick.
  probe(): void;
  // Tears the hub socket down (tab teardown, tests), along with the
  // direct plane it fronts and the tab's client runtime.
  stop(): Promise<void>;
};

export const CLIENT_CONFIG_KEY = "sm.web.clientConfig";
const SHARED_SETTINGS_KEY = "sm.web.sharedSettings";
export function createWebBridge(deps: WebBridgeDeps): WebBridge {
  const config = resolveServiceConfig(deps.env);
  const store = createWebAccountStore(deps.localStorage);
  const deviceId = getWebDeviceId(deps.localStorage);
  const service = createAccountService({
    baseUrl: config.hubUrl,
    fetchImpl: deps.fetchImpl,
  });
  const tab = createLocalRegistrar({ validateOutputs: deps.isDev });
  // A sign-out whose revoke never reached the hub is delivered at the
  // next boot (enroll.ts retryParkedRevoke), the desktop's rule too.
  void retryParkedRevoke({ config, service, store, deviceId });

  // ---- hub socket lifecycle ----

  // The direct plane's shared composition (shared/hub/directPlane.ts),
  // the same assembly main/ipc/register.ts uses. The browser
  // differences are exactly the declared deps: identity facts from
  // this bridge, fan-out on the tab's registrar, dialableKinds
  // ["tunnel"] (an https page cannot dial ws:// interface candidates,
  // mixed content, so peers are asked for wss tunnel candidates only
  // and mint no lan ticket for this caller), no connectInfo server
  // (web/hub/connection.ts), and no host half (no direct listener, no cloudflared, so the
  // status snapshot carries no tunnel state).
  const traceHub = createHubTrace();
  // Both live until the bridge stops.
  const hubScope = Scope.makeUnsafe();
  const { directPlane, connection } = Effect.runSync(
    Effect.gen(function* () {
      const plane: DirectPlane.DirectPlane = yield* DirectPlane.make({
        connection: () => hub,
        localDeviceId: () => deviceId,
        localAppVersion: () => deps.appVersion,
        broadcastStatus: (status) => {
          traceHub(status);
          tab.push(hubContract, "statusChanged", status);
        },
        broadcastPeerPush: (push) => tab.push(hubContract, "peerPush", push),
        dialableKinds: deps.dialableKinds ?? ["tunnel"],
        // One device per browser profile, a link per tab: a host keeps a set
        // of links per web device, and the hub relays to each.
        deviceKind: "web",
      });
      const hub: HubConnection = yield* WebHub.make({
        onChange: () => plane.handleConnectionChange(),
      });
      return { directPlane: plane, connection: hub };
    }).pipe(Scope.provide(hubScope)),
  );
  const hubHandlers = directPlane.handlers;

  // Mirrors main/ipc/register.ts refreshHubConnection: reconcile the
  // socket with the account state, resolving inside the serialized
  // lifecycle, and degrade any failure to a log line. An unconfigured
  // build stops the socket instead of dialing nowhere (the account
  // status says so to the UI), and a device hub refusing the ticket
  // mint blocks the supervisor like it would the desktop's (a
  // deterministic refusal must not loop), which the device pages show
  // as the socket's blocked phase.
  function refreshHub(): Promise<void> {
    return Effect.runPromise(
      connection
        .refresh(
          Effect.sync(() => {
            if (!isConfigured(config)) return null;
            const record = store.read();
            if (record === null) return null;
            return {
              hubUrl: config.hubUrl,
              accountId: record.accountId,
              deviceId,
              deviceKey: record.deviceKey,
              mintTicket: async (connectionId, signal) => {
                const fresh = store.read();
                if (fresh === null) {
                  throw new Error("signed out, no hub credential");
                }
                return (
                  await service.mintTicket(
                    fresh.credential,
                    connectionId,
                    signal,
                  )
                ).ticket;
              },
            };
          }),
        )
        .pipe(
          Effect.ignoreCause({
            log: "Warn",
            message: "[hub] connection refresh failed",
          }),
        ),
    );
  }

  // ---- account module ----

  // Read off the same user agent as the name, once: it cannot change
  // while the page lives.
  const detectedIcon = defaultWebDeviceShape(deps.userAgent);

  // Any account transition re-reconciles the hub socket and fans the
  // change out so every account query re-reads. The account last seen
  // is kept here, since another tab's change arrives with no call of
  // this tab's (notifyAccountChanged).
  let knownAccountId: string | null = store.read()?.accountId ?? null;
  function accountChanged(): void {
    const before = knownAccountId;
    const after = store.read()?.accountId ?? null;
    knownAccountId = after;
    // The shared settings' copy was built under the account before.
    if (after !== before) sharedSettingsCopy.clear();
    if (departed({ before, after })) {
      // The client config's peer-keyed picks (withoutPeerState): in
      // localStorage they would outlive even the person, on a shared
      // browser profile.
      writeKey(
        deps.localStorage,
        CLIENT_CONFIG_KEY,
        JSON.stringify(
          withoutPeerState(
            readJsonKey(
              deps.localStorage,
              CLIENT_CONFIG_KEY,
              StoredClientConfigSchema,
              {},
            ),
          ),
        ),
      );
      clientConfigChanged();
    }
    tab.push(accountContract, "changed", { accountId: after });
    void refreshHub();
  }

  const accountHandlers = makeAccountHandlers({
    config: () => config,
    store: () => store,
    service: () => service,
    deviceId: async () => deviceId,
    defaultName: async () => ({
      name: defaultWebDeviceName(deps.userAgent, deps.browserHints),
      provisional: false,
    }),
    detectedIcon: async () => detectedIcon,
    // A legal opaque label beside the desktop's os.platform() values in
    // EnrollRequestSchema's 1..64 bound.
    platform: WEB_PLATFORM,
    sharedSignIn: () => false,
    changed: accountChanged,
    devicesListed: () => {},
    // A web client is a refuse-all host (web/hub/connection.ts): it
    // serves no peer calls, so switching command access on would
    // promise something the transport can never honor.
    acceptsCommands: () => false,
    setAcceptsCommands: () => {
      throw new Error("a web client cannot change command access");
    },
  });

  // ---- clientConfig module ----

  const readClientConfig = () =>
    readJsonKey(
      deps.localStorage,
      CLIENT_CONFIG_KEY,
      StoredClientConfigSchema,
      {},
    );
  // The watchers of this tab's client config (clientConfig:watch), told
  // of this tab's writes and, through notifyClientConfigChanged, another
  // tab's.
  const clientConfigWatchers = new Set<(stored: unknown) => void>();
  const clientConfigChanged = () => {
    const stored = readClientConfig();
    for (const watcher of clientConfigWatchers) watcher(stored);
  };
  const writeClientConfig = (next: Record<string, unknown>) => {
    writeKey(deps.localStorage, CLIENT_CONFIG_KEY, JSON.stringify(next));
    clientConfigChanged();
  };
  // A tab is a launch of its own: its load turns an "Each launch"
  // rotation, once, as the desktop's main process does per run.
  const rotationTurnOf = rotationOwner();
  const clientConfigHandlers: Handlers<typeof clientConfigContract> = {
    read: readClientConfig,
    // Over the stored config as it is now, which another tab may have
    // written since this one last read it.
    patch: ({ set, clear }) => {
      const next: Record<string, unknown> = { ...readClientConfig() };
      for (const [key, value] of Object.entries(set)) {
        if (value !== undefined) next[key] = value;
      }
      for (const key of clear) delete next[key];
      writeClientConfig(next);
    },
    rotate: ({ launching }) => {
      const stored = readClientConfig();
      const now = Date.now();
      const turn = rotationTurnOf(stored, now, launching);
      if (turn === null) return null;
      writeClientConfig({ ...stored, ...turn });
      return now;
    },
  };

  // ---- sharedSettings module ----

  // This browser's copy of the shared settings, the one host-scoped
  // module served here: every device keeps a copy, a browser included,
  // so the renderer reads and writes "the local copy" the same way in
  // both shells. No peer can read this one (a web client serves no
  // calls), so what is picked here reaches the others only by the
  // renderer offering it to them (sharedSettingsSync).
  const readSharedSettings = () =>
    readJsonKey(
      deps.localStorage,
      SHARED_SETTINGS_KEY,
      SharedSettingsDocSchema,
      EMPTY_SHARED_SETTINGS,
    );
  // The copy as a view (sharedSettings:watch), the way a host serves its
  // own: as it stands, then every move.
  const sharedSettingsWatchers = new Set<(doc: SharedSettingsDoc) => void>();
  const sharedSettingsCopy = createSharedSettingsCopy(
    {
      read: readSharedSettings,
      // One tab's writes are already serial. Another tab's are not
      // locked against, and the merge absorbs the loser the next time
      // either hears from a peer.
      transact: (next) => {
        const result = next(readSharedSettings());
        if (result !== undefined) {
          writeKey(
            deps.localStorage,
            SHARED_SETTINGS_KEY,
            JSON.stringify(result),
          );
        }
      },
    },
    {
      deviceId: () => deviceId,
      announce: (doc) => {
        tab.push(sharedSettingsContract, "changed", doc);
        for (const watcher of sharedSettingsWatchers) watcher(doc);
      },
    },
  );

  const sharedSettingsHandlers: Handlers<typeof sharedSettingsContract> = {
    read: () => sharedSettingsCopy.read(),
    set: ({ key, value }) => sharedSettingsCopy.set(key, value),
    merge: ({ doc }) => sharedSettingsCopy.merge(doc),
  };

  // ---- shell module ----

  const shellHandlers: Handlers<typeof shellContract> = {
    openExternal: ({ url }) => {
      deps.openExternal(url);
    },
    // There is no folder to reveal from a browser. A silent no-op keeps
    // any shared component's affordance harmless.
    showItemInFolder: () => {},
  };

  tab.served.serve(accountContract, accountHandlers);
  tab.served.serve(clientConfigContract, clientConfigHandlers);
  tab.view(clientConfigContract, "watch", (_input, observer) => {
    observer.value(readClientConfig());
    clientConfigWatchers.add(observer.value);
    return () => {
      clientConfigWatchers.delete(observer.value);
    };
  });
  const hubServed: EffectHandlers<typeof hubContract> = {
    status: () =>
      Effect.promise(async () => hubHandlers.status(undefined, undefined)),
    invokePeer: servedInvokePeer(() => hubHandlers),
  };
  tab.served.serve(hubContract, hubServed);
  tab.view(hubContract, "watchPeer", (input, observer) =>
    hubHandlers.watchPeer(
      input as Parameters<typeof hubHandlers.watchPeer>[0],
      observer,
    ),
  );
  tab.served.serve(sharedSettingsContract, sharedSettingsHandlers);
  tab.view(sharedSettingsContract, "watch", (_input, observer) => {
    observer.value(sharedSettingsCopy.read());
    sharedSettingsWatchers.add(observer.value);
    return () => {
      sharedSettingsWatchers.delete(observer.value);
    };
  });
  tab.served.serve(shellContract, shellHandlers);
  tab.served.serve(releasesContract, {
    list: () => fetchReleases(deps.fetchImpl),
  });

  // The tab serves both scopes itself: the client modules, and the host
  // ones it has (its copy of the shared settings) or refuses.
  const client = startClientNow(
    Layer.succeed(ClientLinks, ClientLinks.of({ linkOf: () => tab.link })),
  );
  const api = {
    deviceId,
    appVersion: deps.appVersion,
    // The same mount decision the desktop preload delivers over argv:
    // empty means no ClerkProvider (ClerkGate).
    clerkPublishableKey: config.publishableKey,
    isDev: deps.isDev,
    // App-only UI (the port-forward controls) gates its mount on this:
    // a browser cannot bind a local TCP listener, and the tab's registrar
    // rejects the client-scoped portForward channels anyway.
    isElectron: false,
    ...client.api,
  };

  return {
    api,
    links: client.links,

    notifyAccountChanged: accountChanged,
    notifyClientConfigChanged: clientConfigChanged,

    refreshHub,

    probe: () => {
      connection.probe();
      directPlane.probe();
    },

    stop: async () => {
      await Effect.runPromise(Scope.close(hubScope, Exit.void));
      await client.dispose();
    },
  };
}
