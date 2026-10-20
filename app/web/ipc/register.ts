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
import { hubConnectInputs } from "@shared/account/hubConnect";
import { createAccountService } from "@shared/account/service";
import { makeAccountHandlers } from "@shared/account/handlers";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
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
import { callFailureOf } from "@shigomori/contracts/errors";
import type { EffectHandlers, Handlers } from "@shigomori/contracts/types";
import { servedInvokePeer, servedWatchPeer } from "@shared/hub/bridgeHandlers";
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
import type { AccountStatus } from "@shigomori/contracts/modules/account";
import { retryParkedRevoke } from "@shared/account/enroll";
import * as WebHub from "../hub/connection";
import { log } from "@shared/log";
import { createHubTrace } from "../hub/trace";
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
import { createWebAccountStore } from "../account/store";
import { readJsonKey, writeKey, type KeyValueStorage } from "../lib/kvStorage";
import { createLocalRegistrar } from "./localRegistrar";

export type WebBridgeDeps = {
  // Persistent per-browser storage (window.localStorage in the real
  // client): the device id, the credential envelope and clientConfig.
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
  fetchImpl?: typeof fetch;
  // Test seam: the candidate kinds the tab dials. A browser page dials
  // the wss tunnel only (mixed content forbids ws:// under https), which
  // a proof cannot serve, so a proof dials the listener's lan candidate.
  dialableKinds?: ReadonlyArray<"lan" | "tunnel">;
  // navigator.locks, which every tab of the profile shares.
  locks?: Pick<LockManager, "request">;
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
  // The same for the client config, and the shared settings' copy,
  // another tab wrote.
  notifyClientConfigChanged(): void;
  notifySharedSettingsChanged(): void;
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
// How long a tab waits for another tab's enroll.
const ENROLL_WAIT_MS = 30_000;
// The profile's tabs' account changes, one tab at a time: its device
// id, its enrollment and its sign-out.
const ACCOUNT_LOCK = "sm.web.accountChange";

const isDomError = (error: unknown, name: string): boolean =>
  error instanceof DOMException && error.name === name;

export const SHARED_SETTINGS_KEY = "sm.web.sharedSettings";

// The profile's device id. One already stored is read as it is (a tab
// boots at once); a missing or mangled one is minted under the account
// lock, so two fresh tabs can't mint two and enroll under one. A tab
// that waits past ENROLL_WAIT_MS behind another's enrollment reads the
// id that tab minted before it enrolled, as a sign-out goes ahead.
export async function establishWebDeviceId(
  storage: KeyValueStorage,
  locks: Pick<LockManager, "request"> | undefined = globalThis.navigator?.locks,
): Promise<string> {
  const stored = readWebDeviceId(storage);
  if (stored !== null) return stored;
  if (locks === undefined) return getWebDeviceId(storage);
  return await locks
    .request(
      ACCOUNT_LOCK,
      { signal: AbortSignal.timeout(ENROLL_WAIT_MS) },
      async () => getWebDeviceId(storage),
    )
    .catch((error: unknown) => {
      if (isDomError(error, "TimeoutError")) return getWebDeviceId(storage);
      throw error;
    });
}

export function createWebBridge(deps: WebBridgeDeps): WebBridge {
  const config = resolveServiceConfig(deps.env);
  const store = createWebAccountStore(deps.localStorage);
  const { deviceId } = deps;
  const service = createAccountService({
    baseUrl: config.hubUrl,
    fetchImpl: deps.fetchImpl,
  });
  const tab = createLocalRegistrar({ validateOutputs: deps.isDev });
  // A sign-out whose revoke never reached the hub is delivered at the
  // next boot (enroll.ts retryParkedRevoke), the desktop's rule too.
  // Its clear can fail in a storage that refuses writes, the revoke
  // itself delivered.
  void retryParkedRevoke({ config, service, store, deviceId }).catch(
    (error: unknown) => log.warn("[account] parked revoke:", error),
  );

  // ---- hub socket lifecycle ----

  // The direct plane's shared composition (shared/hub/directPlane.ts),
  // the same assembly the host's (host/process/wires.ts). The browser
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

  // As the host's (host/process/wires.ts): reconcile the socket with the
  // account state, resolving inside the serialized
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
          Effect.sync(() =>
            hubConnectInputs(() => {
              const record = isConfigured(config) ? store.read() : null;
              return record === null
                ? null
                : { ...record, hubUrl: config.hubUrl, service };
            }, deviceId),
          ),
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
  async function accountChanged(): Promise<void> {
    const before = knownAccountId;
    const after = store.read()?.accountId ?? null;
    knownAccountId = after;
    // The old account's sessions close first: a peer's push landing
    // between the clear and their close would refill the copy, as the
    // host orders it too (host/process/handlers.ts).
    await refreshHub();
    if (departed({ before, after })) {
      // The shared settings' copy and the client config's peer-keyed
      // picks (withoutPeerState): in localStorage they would outlive
      // even the person, on a shared browser profile.
      sharedSettingsCopy.clear();
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
    transitions: Semaphore.makeUnsafe(1),
    devicesListed: () => {},
    // A web client is a refuse-all host (web/hub/connection.ts): it
    // serves no peer calls, so switching command access on would
    // promise something the transport can never honor.
    acceptsCommands: () => false,
    setAcceptsCommands: () => {
      throw new Error("a web client cannot change command access");
    },
  });

  // The profile's tabs share its storage, and the hub keeps the last
  // enroll's credential alone: two tabs enrolling at once (a sign-in
  // reaches every tab of the profile) could store the one the other
  // rotated away. One tab enrolls at a time, and one whose wait saw
  // another tab store a credential answers with that. A second call in
  // this tab rides the one under way, as the handlers' own join does.
  // The tab enrolls under the profile's id as storage holds it, so a
  // credential never lands beside an id other than its own.
  const locks = deps.locks ?? globalThis.navigator?.locks;
  let enrolling: Promise<AccountStatus> | undefined;
  const enrollOneTab: typeof accountHandlers.enroll = (token, ctx) => {
    if (enrolling !== undefined) return enrolling;
    const before = store.read()?.credential;
    const enrollHere = async () => {
      keepWebDeviceId(deps.localStorage, deviceId);
      return store.read()?.credential === before
        ? accountHandlers.enroll(token, ctx)
        : accountHandlers.status(undefined, ctx);
    };
    const run = (
      locks === undefined
        ? enrollHere()
        : // A tab whose enroll hangs (no timeout of its own) holds the
          // others for a while, not for good: theirs then fail, and retry.
          locks
            .request(
              ACCOUNT_LOCK,
              { signal: AbortSignal.timeout(ENROLL_WAIT_MS) },
              enrollHere,
            )
            .catch((error: unknown) => {
              // Given up while waiting: said as what the user can do.
              if (isDomError(error, "TimeoutError")) {
                throw new Error(
                  "Another tab of this browser is still enrolling it. Try again once it's done.",
                );
              }
              throw error;
            })
    ).finally(() => {
      enrolling = undefined;
    });
    enrolling = run;
    return run;
  };

  // A sign-out takes its turn behind another tab's enrollment too, as
  // this tab's does behind its own (AccountShell.transitions), or the
  // enrollment's late write signs the profile back in. A local sign-out
  // must land, so one that waited out ENROLL_WAIT_MS goes ahead.
  const signOutOneTab: typeof accountHandlers.signOut = (input, ctx) =>
    locks === undefined
      ? accountHandlers.signOut(input, ctx)
      : locks
          .request(
            ACCOUNT_LOCK,
            { signal: AbortSignal.timeout(ENROLL_WAIT_MS) },
            () => accountHandlers.signOut(input, ctx),
          )
          .catch((error: unknown) => {
            if (isDomError(error, "TimeoutError")) {
              return accountHandlers.signOut(input, ctx);
            }
            throw error;
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
    enroll: enrollOneTab,
    signOut: signOutOneTab,
  });
  tab.served.serve(clientConfigContract, clientConfigHandlers);
  tab.served.view(clientConfigContract, {
    watch: () => SubscriptionRef.changes(clientConfigNow),
  });
  // As the host serves its own (host/process/handlers.ts).
  const hubServed: EffectHandlers<typeof hubContract> = {
    status: () =>
      Effect.tryPromise({
        try: async () => hubHandlers.status(undefined, undefined),
        catch: callFailureOf,
      }),
    invokePeer: servedInvokePeer(() => hubHandlers),
  };
  tab.served.serve(hubContract, hubServed);
  tab.served.view(hubContract, {
    watchPeer: servedWatchPeer(() => hubHandlers),
  });
  tab.served.serve(sharedSettingsContract, sharedSettingsHandlers);
  tab.served.view(sharedSettingsContract, {
    watch: () => SubscriptionRef.changes(sharedSettingsNow),
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

    notifyAccountChanged: () => void accountChanged(),
    notifyClientConfigChanged: clientConfigChanged,
    notifySharedSettingsChanged: () =>
      announceSharedSettings(sharedSettingsCopy.read()),

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
