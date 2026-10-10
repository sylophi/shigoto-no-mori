// The browser binding's composition root: the web client is a device
// with no host of its own, so it reaches every
// host as a peer, over the device link through the hub (the direct
// plane below), and serves only itself, in the page: the client modules
// (clientConfig, account, hub, shell, releases) and its copy of the
// shared settings, on the tab's local registrar (localRegistrar.ts). It
// builds the SAME window.api surface the desktop does: the scalar facts
// (deviceId, appVersion, isDev, isElectron) plus the clients over that
// registrar, on the tab's client runtime (renderer/lib/runtime), so
// renderer components mount unmodified.
//
// Every platform fact arrives through WebBridgeDeps rather than a
// browser global read at module scope, so the headless bridge check
// drives the whole factory under node with in-memory storage and a
// recording fetch.
import { logFailure } from "@shared/log";
import { singleFlight } from "@shared/util/singleFlight";
import { createAccountService } from "@shared/account/service";
import * as Layer from "effect/Layer";
import { ClientLinks } from "@/lib/runtime/ClientLinks";
import { startClientNow } from "@/lib/runtime/client";
import type { ClientApi } from "@/lib/runtime/Api";
import {
  accountContract,
  type AccountStatus,
} from "@shigomori/contracts/modules/account";
import { clientConfigContract } from "@shigomori/contracts/modules/clientConfig";
import { withoutPeerState } from "@shigomori/contracts/schemas/config";
import { hubContract } from "@shigomori/contracts/modules/hub";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import { releasesContract } from "@shigomori/contracts/modules/releases";
import { shellContract } from "@shigomori/contracts/modules/shell";
import { broadcastAll, registerContract } from "@shared/ipc/registerContract";
import type { Handlers } from "@shigomori/contracts/types";
import { createDirectPlane } from "@shared/hub/directPlane";
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
import {
  effectiveDeviceIcon,
  enrollDevice,
  retryParkedRevoke,
  signOutDevice,
  syncHubDevice,
  updateDevice,
  type DeviceFields,
} from "@shared/account/enroll";
import { createHubConnection } from "../hub/connection";
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
  // The window.api surface. Assigning it to window.api is what
  // typechecks it against RendererApi (renderer/window.d.ts).
  api: {
    deviceId: string;
    appVersion: string;
    clerkPublishableKey: string;
    isDev: boolean;
    isElectron: boolean;
  } & ClientApi;
  // The tab's links, for the boot's atoms.
  links: ClientLinks["Service"];
  // Cross-tab correction: another tab changed the persisted account
  // (a storage event); re-read and fan out exactly like a local
  // transition. The storage event itself only fires in OTHER tabs, so
  // the tab's own push and this never double-fire.
  notifyAccountChanged(): void;
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

const CLIENT_CONFIG_KEY = "sm.web.clientConfig";
const SHARED_SETTINGS_KEY = "sm.web.sharedSettings";
export function createWebBridge(deps: WebBridgeDeps): WebBridge {
  const config = resolveServiceConfig(deps.env);
  const store = createWebAccountStore(deps.localStorage);
  const deviceId = getWebDeviceId(deps.localStorage);
  const service = createAccountService({
    baseUrl: config.hubUrl,
    fetchImpl: deps.fetchImpl,
  });
  const tab = createLocalRegistrar();
  const registrarOpts = { validateOutputs: deps.isDev };
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
  const directPlane = createDirectPlane({
    connection: () => connection,
    localDeviceId: () => deviceId,
    localAppVersion: () => deps.appVersion,
    broadcastStatus: (status) => {
      traceHub(status);
      broadcastAll(hubContract, "statusChanged", status, tab.server);
    },
    broadcastPeerPush: (push) =>
      broadcastAll(hubContract, "peerPush", push, tab.server),
    dialableKinds: deps.dialableKinds ?? ["tunnel"],
    // One device per browser profile, a link per tab: a host keeps a set
    // of links per web device, and the hub relays to each.
    deviceKind: "web",
  });
  const hubHandlers = directPlane.handlers;

  const connection = createHubConnection({
    onChange: () => directPlane.handleConnectionChange(),
  });

  // Mirrors main/ipc/register.ts refreshHubConnection: reconcile the
  // socket with the account state, resolving inside the serialized
  // lifecycle, and degrade any failure to a log line. An unconfigured
  // build stops the socket instead of dialing nowhere (the account
  // status says so to the UI), and a device hub refusing the ticket
  // mint blocks the supervisor like it would the desktop's (a
  // deterministic refusal must not loop), which the device pages show
  // as the socket's blocked phase.
  function refreshHub(): Promise<void> {
    return logFailure("[hub] connection refresh failed", () =>
      connection.refresh(async () => {
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
              await service.mintTicket(fresh.credential, connectionId, signal)
            ).ticket;
          },
        };
      }),
    );
  }

  // ---- account module ----

  // A device's name or icon change, made on the hub (updateDevice),
  // then the fan-out so every tab re-reads the registry.
  async function updateAccountDevice(
    target: string,
    patch: DeviceFields,
  ): Promise<AccountStatus> {
    const record = store.read();
    if (record === null || !isConfigured(config)) {
      throw new Error("cannot change a device while signed out");
    }
    await updateDevice(
      { service, store, deviceId, detectedIcon },
      record,
      target,
      patch,
    );
    accountChanged();
    return readStatus();
  }

  function defaultDeviceName(): string {
    return defaultWebDeviceName(deps.userAgent, deps.browserHints);
  }

  // Read off the same user agent as the name, once: it cannot change
  // while the page lives.
  const detectedIcon = defaultWebDeviceShape(deps.userAgent);

  function readStatus(): AccountStatus {
    const record = store.read();
    return {
      configured: isConfigured(config),
      signedIn: record !== null,
      accountId: record?.accountId ?? "",
      deviceName: record?.deviceName ?? defaultDeviceName(),
      deviceIcon: effectiveDeviceIcon(record, store, detectedIcon),
      detectedDeviceIcon: detectedIcon,
      sharedSignIn: false,
      needsDeviceKey: store.readWithoutKey() !== null,
    };
  }

  // Any account transition re-reconciles the hub socket and fans the
  // change out so every account query re-reads, matching the desktop's
  // emitChanged wiring in main/ipc/modules/account.ts. Like there, the account
  // the copy of the shared settings was built under is tracked so a
  // sign-out or an account switch drops it (a rename keeps it).
  let settingsAccountId: string | null = store.read()?.accountId ?? null;
  function accountChanged(): void {
    const accountId = store.read()?.accountId ?? null;
    if (accountId !== settingsAccountId) {
      settingsAccountId = accountId;
      sharedSettingsCopy.clear();
      // And the client config's peer-keyed picks (withoutPeerState): in
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
    }
    broadcastAll(accountContract, "changed", { accountId }, tab.server);
    void refreshHub();
  }

  // Re-entrancy guards mirroring the desktop handler's: a re-fired
  // reconciler effect or a second tab must not race two enrolls (the
  // hub rotates the credential per enroll, so racers can strand the
  // stored one) or two revokes. Same-tab only: the storage key is
  // still shared across tabs, but a cross-tab race is closed by the
  // reconciler's re-read after the storage event.
  const enrollOnce = singleFlight<AccountStatus>();
  const signOutOnce = singleFlight<void>();

  // Removing a device from the account, served over the
  // account:revokeDevice client channel (what the account page calls).
  async function revokeDeviceOnAccount(targetDeviceId: string): Promise<void> {
    const record = store.read();
    if (record === null) {
      throw new Error("cannot revoke a device while signed out");
    }
    await service.revoke(record.credential, targetDeviceId);
    // Revoking THIS browser invalidates its own credential, so the
    // local sign-out follows immediately rather than waiting for the
    // hub to refuse the next call. Callers revoking self end the
    // Clerk session first (DevicesPage's SelfRevokeButton does), so no
    // session is left live with no device under it.
    if (targetDeviceId === deviceId) store.clear();
    accountChanged();
  }

  const accountHandlers: Handlers<typeof accountContract> = {
    status: () => readStatus(),

    // Exchanges the Clerk session token ClerkAccountSync minted for the
    // hub device credential, enrolling this browser under platform
    // "web" (a legal opaque label beside the desktop's os.platform()
    // values in EnrollRequestSchema's 1..64 bound).
    enroll: (token) =>
      enrollOnce(async () => {
        await enrollDevice(
          {
            config,
            service,
            store,
            deviceId,
            fallbackDeviceName: defaultDeviceName(),
            platform: WEB_PLATFORM,
            detectedIcon,
          },
          token,
        );
        accountChanged();
        return readStatus();
      }),

    // The shared best-effort revoke-then-clear (the desktop handler
    // adds a warn-once and its grant clear on top of the same core).
    signOut: () =>
      signOutOnce(async () => {
        await signOutDevice({ config, service, store, deviceId });
        accountChanged();
      }),

    revokeDevice: (targetDeviceId) => revokeDeviceOnAccount(targetDeviceId),

    listDevices: async () => {
      const record = store.read();
      if (record === null || !isConfigured(config)) return [];
      const devices = await service.listDevices(record.credential);
      if (
        syncHubDevice(
          { service, store, deviceId, detectedIcon },
          record,
          devices,
        )
      ) {
        accountChanged();
      }
      return devices;
    },

    setDeviceName: ({ deviceId: target, name }) =>
      updateAccountDevice(target, { name }),

    setDeviceIcon: ({ deviceId: target, icon }) =>
      updateAccountDevice(target, { icon }),

    // A web client is a refuse-all host (web/hub/connection.ts): it
    // serves no peer calls, so switching command access on would
    // promise something the transport can never honor. Failing loudly
    // beats a switch that silently does nothing.
    acceptsCommands: () => false,
    setAcceptsCommands: () => {
      throw new Error("a web client cannot change command access");
    },
  };

  // ---- clientConfig module ----

  const clientConfigHandlers: Handlers<typeof clientConfigContract> = {
    read: () =>
      readJsonKey(
        deps.localStorage,
        CLIENT_CONFIG_KEY,
        StoredClientConfigSchema,
        {},
      ),
    write: ({ config: next }) => {
      writeKey(deps.localStorage, CLIENT_CONFIG_KEY, JSON.stringify(next));
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
        broadcastAll(sharedSettingsContract, "changed", doc, tab.server);
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

  registerContract(accountContract, accountHandlers, tab.server, registrarOpts);
  registerContract(
    clientConfigContract,
    clientConfigHandlers,
    tab.server,
    registrarOpts,
  );
  registerContract(hubContract, hubHandlers, tab.server, registrarOpts);
  tab.view("hub:watchPeer", (input, observer) =>
    hubHandlers.watchPeer(
      input as Parameters<typeof hubHandlers.watchPeer>[0],
      observer,
    ),
  );
  registerContract(
    sharedSettingsContract,
    sharedSettingsHandlers,
    tab.server,
    registrarOpts,
  );
  tab.view("sharedSettings:watch", (_input, observer) => {
    observer.value(sharedSettingsCopy.read());
    sharedSettingsWatchers.add(observer.value);
    return () => {
      sharedSettingsWatchers.delete(observer.value);
    };
  });
  registerContract(shellContract, shellHandlers, tab.server, registrarOpts);
  registerContract(
    releasesContract,
    { list: () => fetchReleases(deps.fetchImpl) },
    tab.server,
    registrarOpts,
  );

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

    refreshHub,

    probe: () => {
      connection.probe();
      directPlane.probe();
    },

    stop: async () => {
      directPlane.stop();
      await connection.stop();
      await client.dispose();
    },
  };
}
