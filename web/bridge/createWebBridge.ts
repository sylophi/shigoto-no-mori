// The web client's window.api factory (v2 step 5, slice B). It builds
// the SAME surface the Electron preload exposes, by the same means: the
// scalar facts (deviceId, appVersion, isDev, isElectron) plus buildApi over
// one ClientTransport per scope. The transports are in-page loopback
// wires instead of the IPC bridge, with the browser-servable client
// modules (clientConfig, account, relay, shell) registered through the
// shared registrar and every OS-bound channel answered by a typed stub
// default. Renderer components therefore mount unmodified: they cannot
// tell this bridge from the preload's.
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
import { directContract } from "@shared/ipc/modules/direct";
import { relayContract } from "@shared/ipc/modules/relay";
import { shellContract } from "@shared/ipc/modules/shell";
import { broadcastAll, registerContract } from "@shared/ipc/registerContract";
import type { Handlers } from "@shared/ipc/types";
import { createDirectPlane } from "@shared/relay/directPlane";
import { isConfigured } from "@shared/account/serviceConfig";
import { StoredClientConfigSchema } from "@shared/schemas";
import { enrollDevice, signOutDevice } from "@shared/account/enroll";
import { createRelayConnection } from "../relay/connection";
import { webServiceConfig } from "../account/config";
import { getWebDeviceId } from "../account/deviceId";
import { defaultWebDeviceName } from "../account/deviceName";
import { createWebAccountStore } from "../account/store";
import {
  createWebAccessStore,
  isRelayRefusedError,
  type WebAccessStore,
} from "../account/webAccess";
import { readKey, writeKey, type KeyValueStorage } from "../lib/kvStorage";
import { createLoopbackWire } from "./loopback";

export type WebBridgeDeps = {
  // Persistent per-browser storage (window.localStorage in the real
  // client): the device id, the credential envelope and clientConfig.
  localStorage: KeyValueStorage;
  // The env record the SM_ACCOUNT_* service config resolves from
  // (import.meta.env in the real client).
  env: Record<string, string | undefined>;
  // navigator.userAgent, for the default device name.
  userAgent: string;
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
  // The deployment-level access state the shell surfaces when the
  // build is unconfigured or the relay refuses this origin.
  webAccess: WebAccessStore;
  // Cross-tab correction: another tab changed the persisted account
  // (a storage event); re-read and fan out exactly like a local
  // transition. The storage event itself only fires in OTHER tabs, so
  // the local loopback broadcast and this never double-fire.
  notifyAccountChanged(): void;
  // Reconciles the relay socket with the current account state.
  refreshRelay(): Promise<void>;
  // Tears the relay socket down (tab teardown, tests), along with the
  // direct plane it fronts.
  stop(): Promise<void>;
};

const CLIENT_CONFIG_KEY = "sm.web.clientConfig";

export function createWebBridge(deps: WebBridgeDeps): WebBridge {
  const config = webServiceConfig(deps.env);
  const store = createWebAccountStore(deps.localStorage);
  const deviceId = getWebDeviceId(deps.localStorage);
  const service = createAccountService({
    baseUrl: config.relayUrl,
    fetchImpl: deps.fetchImpl,
  });
  const webAccess = createWebAccessStore();

  const clientWire = createLoopbackWire("client");
  const hostWire = createLoopbackWire("host");
  const registrarOpts = { validateOutputs: deps.isDev };

  // ---- relay socket lifecycle ----

  // The direct plane's shared composition (shared/relay/directPlane.ts),
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
      broadcastAll(relayContract, "statusChanged", status, clientWire.server),
    broadcastPeerPush: (push) =>
      broadcastAll(relayContract, "peerPush", push, clientWire.server),
    dialableKinds: ["tunnel"],
  });
  const relayHandlers = directPlane.handlers;

  const connection = createRelayConnection({
    // The one channel the wire brokers, supplied here so the binding
    // stays contract-free: a browser dials the broker leg only, it
    // never serves it.
    brokerChannel: directContract.calls.connectInfo.channel,
    onChange: () => directPlane.handleConnectionChange(),
  });

  // Mirrors main/ipc/register.ts refreshRelayConnection: reconcile the
  // socket with the account state, resolving inside the serialized
  // lifecycle, and degrade any failure to a log line. The two web-only
  // additions are the typed access states: an unconfigured build stops
  // the socket instead of dialing nowhere, and an exact origin refusal
  // on the ticket mint stops it instead of a retry loop that can never
  // succeed (see webAccess.ts).
  async function refreshRelay(): Promise<void> {
    try {
      await connection.refresh(async () => {
        if (!isConfigured(config)) {
          webAccess.set({ kind: "unconfigured" });
          return null;
        }
        webAccess.set({ kind: "ok" });
        const record = store.read();
        if (record === null) return null;
        return {
          relayUrl: config.relayUrl,
          accountId: record.accountId,
          deviceId,
          appVersion: deps.appVersion,
          mintTicket: async (signal) => {
            const fresh = store.read();
            if (fresh === null) {
              throw new Error("signed out, no relay credential");
            }
            try {
              return (await service.mintTicket(fresh.credential, signal))
                .ticket;
            } catch (error) {
              if (isRelayRefusedError(error)) {
                webAccess.set({
                  kind: "blocked",
                  message: errorMessageOf(error),
                });
                // The refusal is deterministic for this deployment, so
                // retrying cannot succeed. stop() is serialized by the
                // connection's lifecycle and safe to fire from here.
                void connection.stop();
              }
              throw error;
            }
          },
        };
      });
    } catch (error) {
      console.warn(
        `[relay] connection refresh failed: ${errorMessageOf(error)}`,
      );
    }
  }

  // ---- account module ----

  function defaultDeviceName(): string {
    return defaultWebDeviceName(deps.userAgent);
  }

  function readStatus(): AccountStatus {
    const record = store.read();
    return {
      configured: isConfigured(config),
      signedIn: record !== null,
      accountId: record?.accountId ?? "",
      deviceName: record?.deviceName ?? defaultDeviceName(),
    };
  }

  // Any account transition re-reconciles the relay socket and fans the
  // change out so every account query re-reads, matching the desktop's
  // emitChanged wiring in main/ipc/index.ts.
  function accountChanged(): void {
    broadcastAll(accountContract, "changed", undefined, clientWire.server);
    void refreshRelay();
  }

  // Re-entrancy guards mirroring the desktop handler's: a re-fired
  // reconciler effect or a second tab must not race two enrolls (the
  // relay rotates the credential per enroll, so racers can strand the
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
    // relay to refuse the next call. Callers revoking self MUST end
    // the Clerk session first (DevicesPage's SelfRevokeButton does):
    // with the session still live, ClerkAccountSync sees "signed in,
    // not enrolled" and re-enrolls, silently undoing the revoke.
    if (targetDeviceId === deviceId) store.clear();
    accountChanged();
  }

  const accountHandlers: Handlers<typeof accountContract> = {
    status: () => readStatus(),

    // Exchanges the Clerk session token ClerkAccountSync minted for the
    // relay device credential, enrolling this browser under platform
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
            platform: "web",
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
      return service.listDevices(record.credential);
    },

    setDeviceName: (name) => {
      const record = store.read();
      // Renaming only means something once a credential is stored, the
      // same rule as the desktop handler.
      if (record !== null) {
        store.write({ ...record, deviceName: name });
        accountChanged();
      }
      return readStatus();
    },

    // A web client is a refuse-all host (web/relay/connection.ts): it
    // serves no peer calls, so a command grant would promise something
    // the transport can never honor. Failing loudly beats a grant that
    // silently does nothing.
    grantCommands: () => {
      throw new Error("a web client cannot grant command access");
    },
    revokeCommands: () => {
      throw new Error("a web client cannot change command access");
    },
    listGrantedDevices: () => [],
  };

  // ---- clientConfig module ----

  const clientConfigHandlers: Handlers<typeof clientConfigContract> = {
    read: () => {
      const raw = readKey(deps.localStorage, CLIENT_CONFIG_KEY);
      if (raw === null) return {};
      try {
        const parsed = StoredClientConfigSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
      } catch {
        // Corrupt storage reads as defaults, and the next write heals it.
        return {};
      }
    },
    write: ({ config: next }) => {
      writeKey(deps.localStorage, CLIENT_CONFIG_KEY, JSON.stringify(next));
    },
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
  registerContract(
    relayContract,
    relayHandlers,
    clientWire.server,
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
    // empty means no ClerkProvider (web/app/boot.tsx).
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

    webAccess,

    notifyAccountChanged: accountChanged,

    refreshRelay,

    stop: () => {
      directPlane.stop();
      return connection.stop();
    },
  };
}
