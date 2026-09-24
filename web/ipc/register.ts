// The browser binding's composition root: the twin of main/ipc/register.ts
// (which registers the handlers on the Electron and remote wires and
// assembles the direct plane) and main/preload.ts (which builds
// window.api) in one, since a browser has no process boundary to split
// them across. It builds the SAME window.api surface the preload
// exposes, by the same means: the scalar facts (deviceId, appVersion,
// isDev, isElectron) plus buildApi over one ClientTransport per scope.
// The transports are in-page loopback wires (loopback.ts, the twin of
// main/preloadTransport.ts) instead of the IPC bridge, with the
// browser-servable client modules (clientConfig, account, hub, shell)
// registered through the shared registrar and every OS-bound channel
// answered by a typed stub default. Renderer components therefore
// mount unmodified: they cannot tell this bridge from the preload's.
//
// Every platform fact arrives through WebBridgeDeps rather than a
// browser global read at module scope, so the headless bridge check
// drives the whole factory under node with in-memory storage and a
// recording fetch.
import { errorMessageOf } from "@shared/errors";
import { createAccountService } from "@shared/account/service";
import { buildApi } from "@shared/ipc/client";
import {
  accountContract,
  type AccountStatus,
} from "@shared/ipc/modules/account";
import { clientConfigContract } from "@shared/ipc/modules/clientConfig";
import { withoutPeerState } from "@shared/schemas/config";
import { directContract } from "@shared/ipc/modules/direct";
import { hubContract } from "@shared/ipc/modules/hub";
import { sharedSettingsContract } from "@shared/ipc/modules/sharedSettings";
import { shellContract } from "@shared/ipc/modules/shell";
import { broadcastAll, registerContract } from "@shared/ipc/registerContract";
import type { Handlers } from "@shared/ipc/types";
import { createDirectPlane } from "@shared/hub/directPlane";
import { isConfigured } from "@shared/account/serviceConfig";
import {
  SharedSettingsDocSchema,
  StoredClientConfigSchema,
} from "@shared/schemas";
import {
  createSharedSettingsCopy,
  EMPTY_SHARED_SETTINGS,
} from "@shared/sharedSettings";
import { WEB_PLATFORM } from "@shared/account/platform";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import {
  effectiveDeviceIcon,
  enrollDevice,
  retryParkedRevoke,
  signOutDevice,
  syncHubDevice,
  updateDevice,
} from "@shared/account/enroll";
import { createHubConnection } from "../hub/connection";
import { webServiceConfig } from "../account/config";
import { getWebDeviceId } from "../account/deviceId";
import { defaultWebDeviceName, type BrowserHints } from "../account/deviceName";
import { defaultWebDeviceShape } from "../account/deviceIcon";
import { createWebAccountStore } from "../account/store";
import { readJsonKey, writeKey, type KeyValueStorage } from "../lib/kvStorage";
import { createLoopbackWire } from "./loopback";

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
  } & ReturnType<typeof buildApi>;
  // Cross-tab correction: another tab changed the persisted account
  // (a storage event); re-read and fan out exactly like a local
  // transition. The storage event itself only fires in OTHER tabs, so
  // the local loopback broadcast and this never double-fire.
  notifyAccountChanged(): void;
  // Reconciles the hub socket with the current account state.
  refreshHub(): Promise<void>;
  // The liveness probe for the hub socket and every direct session,
  // fired by the install when the page comes back to the foreground
  // or the browser reports the network back: a socket that died while
  // the tab was hidden or offline is found and redialed in seconds
  // instead of the sidebar reading "Connected" off a corpse until the
  // next heartbeat tick.
  probe(): void;
  // Tears the hub socket down (tab teardown, tests), along with the
  // direct plane it fronts.
  stop(): Promise<void>;
};

const CLIENT_CONFIG_KEY = "sm.web.clientConfig";
const SHARED_SETTINGS_KEY = "sm.web.sharedSettings";
export function createWebBridge(deps: WebBridgeDeps): WebBridge {
  const config = webServiceConfig(deps.env);
  const store = createWebAccountStore(deps.localStorage);
  const deviceId = getWebDeviceId(deps.localStorage);
  const service = createAccountService({
    baseUrl: config.hubUrl,
    fetchImpl: deps.fetchImpl,
  });
  const clientWire = createLoopbackWire("client");
  const hostWire = createLoopbackWire("host");
  const registrarOpts = { validateOutputs: deps.isDev };
  // A sign-out whose revoke never reached the hub is delivered at the
  // next boot (enroll.ts retryParkedRevoke), the desktop's rule too.
  void retryParkedRevoke({ config, service, store, deviceId });

  // ---- hub socket lifecycle ----

  // The direct plane's shared composition (shared/hub/directPlane.ts),
  // the same assembly main/ipc/register.ts uses. The browser
  // differences are exactly the declared deps: identity facts from
  // this bridge, fan-out over the loopback wire, dialableKinds
  // ["tunnel"] (an https page cannot dial ws:// interface candidates,
  // mixed content, so the broker is asked for wss tunnel candidates
  // only and a kind-aware host mints no lan ticket for this caller),
  // and no host half (no direct listener, no cloudflared, so the
  // status snapshot carries no tunnel state).
  const directPlane = createDirectPlane({
    connection: () => connection,
    localDeviceId: () => deviceId,
    localAppVersion: () => deps.appVersion,
    broadcastStatus: (status) =>
      broadcastAll(hubContract, "statusChanged", status, clientWire.server),
    broadcastPeerPush: (push) =>
      broadcastAll(hubContract, "peerPush", push, clientWire.server),
    dialableKinds: ["tunnel"],
  });
  const hubHandlers = directPlane.handlers;

  const connection = createHubConnection({
    // The one channel the wire brokers, supplied here so the binding
    // stays contract-free: a browser dials the broker leg only, it
    // never serves it.
    brokerChannel: directContract.calls.connectInfo.channel,
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
  async function refreshHub(): Promise<void> {
    try {
      await connection.refresh(async () => {
        if (!isConfigured(config)) return null;
        const record = store.read();
        if (record === null) return null;
        return {
          hubUrl: config.hubUrl,
          accountId: record.accountId,
          deviceId,
          appVersion: deps.appVersion,
          mintTicket: async (signal) => {
            const fresh = store.read();
            if (fresh === null) {
              throw new Error("signed out, no hub credential");
            }
            return (await service.mintTicket(fresh.credential, signal)).ticket;
          },
        };
      });
    } catch (error) {
      console.warn(`[hub] connection refresh failed: ${errorMessageOf(error)}`);
    }
  }

  // ---- account module ----

  // A device's name or icon change, made on the hub (updateDevice),
  // then the fan-out so every tab re-reads the registry.
  async function updateAccountDevice(
    target: string,
    patch: { name?: string; icon?: DeviceIcon },
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
    };
  }

  // Any account transition re-reconciles the hub socket and fans the
  // change out so every account query re-reads, matching the desktop's
  // emitChanged wiring in main/ipc/handlers.ts. Like there, the account
  // the copy of the shared settings was built under is tracked so a
  // sign-out or an account switch drops it (a rename keeps it).
  let settingsAccountId: string | null = store.read()?.accountId ?? null;
  function accountChanged(): void {
    const accountId = store.read()?.accountId ?? null;
    if (accountId !== settingsAccountId) {
      settingsAccountId = accountId;
      sharedSettingsCopy.clear();
      // And the client config's peer-keyed picks (withoutPeerState):
      // in localStorage they would outlive even the person, on a
      // shared browser profile.
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
    broadcastAll(accountContract, "changed", { accountId }, clientWire.server);
    void refreshHub();
  }

  // Re-entrancy guards mirroring the desktop handler's: a re-fired
  // reconciler effect or a second tab must not race two enrolls (the
  // hub rotates the credential per enroll, so racers can strand the
  // stored one) or two revokes. Same-tab only: the storage key is
  // still shared across tabs, but a cross-tab race is closed by the
  // reconciler's re-read after the storage event.
  let enrollInFlight: Promise<AccountStatus> | null = null;
  let signOutInFlight: Promise<void> | null = null;

  // Removing a device from the account, served over the
  // account:revokeDevice client channel (what the devices page calls).
  async function revokeDeviceOnAccount(targetDeviceId: string): Promise<void> {
    const record = store.read();
    if (record === null) {
      throw new Error("cannot revoke a device while signed out");
    }
    await service.revoke(record.credential, targetDeviceId);
    // Revoking THIS browser invalidates its own credential, so the
    // local sign-out follows immediately rather than waiting for the
    // hub to refuse the next call. Callers revoking self MUST end
    // the Clerk session first (DevicesPage's SelfRevokeButton does):
    // with the session still live, ClerkAccountSync sees "signed in,
    // not enrolled" and re-enrolls, silently undoing the revoke.
    if (targetDeviceId === deviceId) store.clear();
    accountChanged();
  }

  const accountHandlers: Handlers<typeof accountContract> = {
    status: () => readStatus(),

    // Exchanges the Clerk session token ClerkAccountSync minted for the
    // hub device credential, enrolling this browser under platform
    // "web" (a legal opaque label beside the desktop's os.platform()
    // values in EnrollRequestSchema's 1..64 bound).
    enroll: async (token) => {
      if (enrollInFlight) return enrollInFlight;
      enrollInFlight = (async (): Promise<AccountStatus> => {
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
      })();
      try {
        return await enrollInFlight;
      } finally {
        enrollInFlight = null;
      }
    },

    // The shared best-effort revoke-then-clear (the desktop handler
    // adds a warn-once and its grant clear on top of the same core).
    signOut: async () => {
      if (signOutInFlight) return signOutInFlight;
      signOutInFlight = (async (): Promise<void> => {
        await signOutDevice({ config, service, store, deviceId });
        accountChanged();
      })();
      try {
        return await signOutInFlight;
      } finally {
        signOutInFlight = null;
      }
    },

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
      announce: (doc) =>
        broadcastAll(sharedSettingsContract, "changed", doc, hostWire.server),
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

  registerContract(
    accountContract,
    accountHandlers,
    clientWire.server,
    registrarOpts,
  );
  registerContract(
    clientConfigContract,
    clientConfigHandlers,
    clientWire.server,
    registrarOpts,
  );
  registerContract(hubContract, hubHandlers, clientWire.server, registrarOpts);
  registerContract(
    sharedSettingsContract,
    sharedSettingsHandlers,
    hostWire.server,
    registrarOpts,
  );
  registerContract(
    shellContract,
    shellHandlers,
    clientWire.server,
    registrarOpts,
  );

  const api = {
    deviceId,
    appVersion: deps.appVersion,
    // The same mount decision the desktop preload delivers over argv:
    // empty means no ClerkProvider (ClerkGate).
    clerkPublishableKey: config.publishableKey,
    isDev: deps.isDev,
    // App-only UI (the port-forward controls) gates its mount on this:
    // a browser cannot bind a local TCP listener, and the loopback wire
    // rejects the client-scoped portForward channels anyway.
    isElectron: false,
    ...buildApi({ host: hostWire.client, client: clientWire.client }),
  };

  return {
    api,

    notifyAccountChanged: accountChanged,

    refreshHub,

    probe: () => {
      connection.probe();
      directPlane.probe();
    },

    stop: () => {
      directPlane.stop();
      return connection.stop();
    },
  };
}
