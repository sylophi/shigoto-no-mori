// The browser binding's composition root: the web client is a device
// with no host of its own, so it reaches every host as a peer, over
// links its Colibrii device dials (the direct plane below), and serves
// only itself, in the page: the client modules (clientConfig, account,
// hub, shell, releases) and its copy of the shared settings, on the
// tab's local registrar (localRegistrar.ts). It builds the SAME page api
// the desktop does: the scalar facts (deviceId, appVersion, isDev,
// isElectron) plus the clients over that registrar, on the tab's client
// runtime (renderer/lib/runtime), so renderer components mount
// unmodified.
//
// Every platform fact arrives through WebBridgeDeps rather than a
// browser global read at module scope.
import * as Colibrii from "@colibrii/sdk";
import * as ColibriiBrowser from "@colibrii/sdk/browser";
import { accountIdOf, makeAccountHandlers } from "@shared/account/handlers";
import { devicePortOf } from "@shared/account/deviceInfo";
import { profileStore } from "@shared/account/profile";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
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
import type { Handlers } from "@shigomori/contracts/types";
import { servedHub } from "@shared/hub/bridgeHandlers";
import * as DirectPlane from "@shared/hub/directPlane";
import { orInertDevice, unconfiguredDevice } from "@shared/hub/inertDevice";
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
  isConfigured,
  resolveServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import {
  getWebDeviceId,
  keepWebDeviceId,
  readWebDeviceId,
} from "../account/deviceId";
import { defaultWebDeviceName, type BrowserHints } from "../account/deviceName";
import { defaultWebDeviceShape } from "../account/deviceIcon";
import {
  readKey,
  readJsonKey,
  writeKey,
  type KeyValueStorage,
} from "../lib/kvStorage";
import { createLocalRegistrar } from "./localRegistrar";

export type WebBridgeDeps = {
  // Persistent per-browser storage (window.localStorage in the real
  // client): the device id, the profile and clientConfig. The device's
  // enrollment is Colibrii's, in window.localStorage itself.
  localStorage: KeyValueStorage;
  // The profile's device id, as establishWebDeviceId settled it.
  deviceId: string;
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
};

export type WebBridge = {
  // The page's api (renderer/lib/runtime/pageApi.tsx).
  api: RendererApi;
  // Another tab changed the device's name or icon, the client config,
  // or the shared settings' copy (a storage event, which fires only in
  // the OTHER tabs): fan it out like this tab's own change.
  notifyProfileChanged(): void;
  notifyClientConfigChanged(): void;
  notifySharedSettingsChanged(): void;
  // Ends the device (tab teardown, tests), along with the direct plane
  // and the tab's client runtime.
  stop(): Promise<void>;
};

export const CLIENT_CONFIG_KEY = "sm.web.clientConfig";
export const PROFILE_KEY = "sm.web.account";
// Colibrii's store of the device's enrollment, which every tab of the
// profile shares and follows.
const DEVICE_STORE_KEY = "sm.web.device";
// How long a fresh tab waits for another to mint the profile's id.
const MINT_WAIT_MS = 30_000;
const MINT_LOCK = "sm.web.accountChange";

export const SHARED_SETTINGS_KEY = "sm.web.sharedSettings";

// The profile's device id. One already stored is read as it is (a tab
// boots at once). A missing or mangled one is minted under a lock every
// tab of the profile shares (navigator.locks), so two fresh tabs can't
// mint two. A page without navigator.locks (an insecure context) mints
// at once, as does one that waited past MINT_WAIT_MS.
export async function establishWebDeviceId(
  storage: KeyValueStorage,
): Promise<string> {
  const stored = readWebDeviceId(storage);
  if (stored !== null) return stored;
  const mint = () => getWebDeviceId(storage);
  const locks = globalThis.navigator?.locks;
  if (locks === undefined) return mint();
  return locks
    .request(MINT_LOCK, { signal: AbortSignal.timeout(MINT_WAIT_MS) }, mint)
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return mint();
      }
      throw error;
    });
}

export async function createWebBridge(deps: WebBridgeDeps): Promise<WebBridge> {
  const config = resolveServiceConfig(deps.env);
  const { deviceId } = deps;
  const tab = createLocalRegistrar({ validateOutputs: deps.isDev });

  // ---- the device ----

  // One device per browser profile, a hub connection per tab. It and the
  // plane live until the bridge stops.
  const deviceScope = Scope.makeUnsafe();
  const device: Colibrii.Device = isConfigured(config)
    ? await Effect.runPromise(
        Colibrii.make({
          hub: config.hubUrl,
          app: config.app,
          connections: "multi",
          deviceId,
        }).pipe(
          Effect.provide(
            Layer.merge(
              ColibriiBrowser.layer,
              ColibriiBrowser.layerLocalStorageStore(DEVICE_STORE_KEY),
            ),
          ),
          Scope.provide(deviceScope),
          orInertDevice,
        ),
      )
    : unconfiguredDevice;

  // The direct plane's shared composition (shared/hub/directPlane.ts),
  // the same assembly the host's (host/process/wires.ts), with no
  // tunnel: a page runs none.
  const directPlane = Effect.runSync(
    DirectPlane.make({
      device,
      localDeviceId: () => deviceId,
      localAppVersion: () => deps.appVersion,
      broadcastStatus: (status) =>
        tab.push(hubContract, "statusChanged", status),
      broadcastPeerPush: (push) => tab.push(hubContract, "peerPush", push),
    }).pipe(Scope.provide(deviceScope)),
  );
  const hubHandlers = directPlane.handlers;

  // ---- account module ----

  // Read off the same user agent as the name, once: it cannot change
  // while the page lives.
  const detectedIcon = defaultWebDeviceShape(deps.userAgent);
  const profile = profileStore({
    readRaw: () => readKey(deps.localStorage, PROFILE_KEY),
    writeRaw: (text) => writeKey(deps.localStorage, PROFILE_KEY, text),
  });

  // The account the device is on, as the tab last heard: every tab of
  // the profile hears a change, its own or another's, from the device.
  let knownAccountId: string | null = null;
  const accountChanged = (state: Colibrii.AccountState) => {
    const before = knownAccountId;
    const after = accountIdOf(state);
    knownAccountId = after;
    if (before === after) return;
    if (departed({ before, after })) {
      // The shared settings' copy and the client config's peer-keyed
      // picks (withoutPeerState): in localStorage they would outlive
      // even the person, on a shared browser profile.
      sharedSettingsCopy.clear();
      writeClientConfig(withoutPeerState(readClientConfig()));
    }
    tab.push(accountContract, "changed", { accountId: after });
  };
  const announceProfile = () =>
    tab.push(accountContract, "changed", { accountId: knownAccountId });

  const devicePort = devicePortOf((call) => Effect.runPromise(call(device)));
  const accountHandlers = makeAccountHandlers({
    config: () => config,
    device: {
      ...devicePort,
      // The tab enrolls under the profile's id as storage holds it, so an
      // enrollment never lands beside an id other than its own.
      enroll: (input) => {
        keepWebDeviceId(deps.localStorage, deviceId);
        return devicePort.enroll(input);
      },
    },
    profile: () => profile,
    deviceId: async () => deviceId,
    defaultName: async () => ({
      name: defaultWebDeviceName(deps.userAgent, deps.browserHints),
      provisional: false,
    }),
    detectedIcon: async () => detectedIcon,
    platform: WEB_PLATFORM,
    sharedSignIn: () => false,
    codeSignIn: false,
    changed: announceProfile,
    acceptsCommandsChanged: () => {},
  });

  // ---- clientConfig module ----

  const readClientConfig = () =>
    readJsonKey(
      deps.localStorage,
      CLIENT_CONFIG_KEY,
      StoredClientConfigSchema,
      {},
    );
  // What clientConfig:watch streams, moved by this tab's writes and,
  // through notifyClientConfigChanged, another tab's.
  const clientConfigNow = Effect.runSync(
    SubscriptionRef.make(readClientConfig()),
  );
  const clientConfigChanged = () =>
    Effect.runSync(SubscriptionRef.set(clientConfigNow, readClientConfig()));
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
  // own: as it stands, then every move, this tab's and, through
  // notifySharedSettingsChanged, another tab's.
  const sharedSettingsNow = Effect.runSync(
    SubscriptionRef.make<SharedSettingsDoc>(readSharedSettings()),
  );
  const announceSharedSettings = (doc: SharedSettingsDoc) => {
    tab.push(sharedSettingsContract, "changed", doc);
    Effect.runSync(SubscriptionRef.set(sharedSettingsNow, doc));
  };
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
      announce: announceSharedSettings,
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

  tab.served.serve(accountContract, {
    ...accountHandlers,
    // A web client serves no peer calls, so switching command access on
    // would promise something it can never honor.
    acceptsCommands: () => false,
    setAcceptsCommands: () => {
      throw new Error("a web client cannot change command access");
    },
  });
  tab.served.serve(clientConfigContract, clientConfigHandlers);
  tab.served.view(clientConfigContract, {
    watch: () => SubscriptionRef.changes(clientConfigNow),
  });
  // As the host serves its own (host/process/handlers.ts).
  const hubServed = servedHub(() => hubHandlers);
  tab.served.serve(hubContract, hubServed.handlers);
  tab.served.view(hubContract, hubServed.views);
  tab.served.serve(sharedSettingsContract, sharedSettingsHandlers);
  tab.served.view(sharedSettingsContract, {
    watch: () => SubscriptionRef.changes(sharedSettingsNow),
  });
  tab.served.serve(shellContract, shellHandlers);
  tab.served.serve(releasesContract, {
    list: () => fetchReleases(),
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
    platform: WEB_PLATFORM,
    pathOfFile: undefined,
    ...client.api,
  };

  // Followed once the copies it clears are made.
  Effect.runSync(
    device.account.pipe(
      Stream.runForEach((state) => Effect.sync(() => accountChanged(state))),
      Effect.forkIn(deviceScope),
    ),
  );

  return {
    api,

    notifyProfileChanged: announceProfile,
    notifyClientConfigChanged: clientConfigChanged,
    notifySharedSettingsChanged: () =>
      announceSharedSettings(sharedSettingsCopy.read()),

    stop: async () => {
      await Effect.runPromise(Scope.close(deviceScope, Exit.void));
      await client.dispose();
    },
  };
}
