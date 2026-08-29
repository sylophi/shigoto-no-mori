// The one electron-facing file of the relay account layer. Everything
// under main/account/ is pure and electron-free so the account check
// script can drive it. This module is where electron enters: safeStorage
// builds the at-rest cipher, app names the userData store path, and
// process.env supplies the service config. Sign-in itself lives in the
// renderer (Clerk's embedded components over the @clerk/electron
// bridge). This module only exchanges the resulting session token for
// the relay device credential. The handlers stay thin, delegating to
// the pure orchestration.
import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { accountContract } from "@shared/ipc/modules/account";
import type { AccountStatus } from "@shared/ipc/modules/account";
import type { Handlers } from "@shared/ipc/types";
import { getDeviceId } from "@host/lib/config/deviceId";
import {
  createAccountStore,
  type AccountStore,
  type StoreCipher,
  type StoredAccount,
} from "../../account/credentialStore";
import { createGrantStore, type GrantStore } from "../../account/grantStore";
import { enrollDevice, signOutDevice } from "@shared/account/enroll";
import {
  createAccountService,
  type AccountService,
} from "@shared/account/service";
import {
  isConfigured,
  mergeServiceEnv,
  parseDotenv,
  resolveServiceConfig,
  type AccountServiceConfig,
} from "@shared/account/serviceConfig";

// Built lazily on first handler use, never at import time. This module is
// imported before app "ready" (registerIpcHandlers runs at the top of
// main/index.ts), and safeStorage.isEncryptionAvailable, app.getPath and
// the dev userData suffix are only reliable once the app is ready, which
// is guaranteed by the time any renderer call lands.
let cachedStore: AccountStore | null = null;
let cachedGrantStore: GrantStore | null = null;
let cachedConfig: AccountServiceConfig | null = null;
let cipherWarned = false;
let revokeWarned = false;
// Re-entrancy guards for account:enroll and account:signOut. A
// concurrent enroll (a re-fired renderer effect, two windows) must not
// enroll twice and rotate the credential mid-write, and concurrent
// sign-outs (the UI button plus ClerkAccountSync reacting to the same
// session end) must not race two revokes, where the second would 401
// against the credential the first already deleted. The second caller
// rides the in-flight promise.
let enrollInFlight: Promise<AccountStatus> | null = null;
let signOutInFlight: Promise<void> | null = null;

// The safeStorage-backed cipher. `available` is the OS keychain's
// verdict: when true the credential is encrypted at rest, when false the
// store keeps plaintext (enc:false) so sign-in still works on a machine
// without a keychain. The plaintext fallback is logged once.
function buildCipher(): StoreCipher {
  const available = safeStorage.isEncryptionAvailable();
  if (!available && !cipherWarned) {
    cipherWarned = true;
    console.warn(
      "[account] OS encryption unavailable, storing the relay credential " +
        "as plaintext in userData.",
    );
  }
  return {
    available,
    encrypt: (plaintext) =>
      safeStorage.encryptString(plaintext).toString("base64"),
    decrypt: (payload) =>
      safeStorage.decryptString(Buffer.from(payload, "base64")),
  };
}

function store(): AccountStore {
  if (cachedStore) return cachedStore;
  cachedStore = createAccountStore({
    filePath: join(app.getPath("userData"), "account.json"),
    cipher: buildCipher(),
  });
  return cachedStore;
}

// The command-grant store, plaintext in userData (a grant list is not a
// bearer secret, see grantStore.ts). Built lazily for the same
// app-ready reason as the credential store.
function grantStore(): GrantStore {
  if (cachedGrantStore) return cachedGrantStore;
  cachedGrantStore = createGrantStore({
    filePath: join(app.getPath("userData"), "grants.json"),
  });
  return cachedGrantStore;
}

// In-memory mirror of the granted peers for the CURRENT account, so the
// direct listener's synchronous dispatch predicate (isPeerCommandGranted)
// never hits the disk or the OS keychain on the hot path. Null means not
// yet built (an empty set is a real built-empty answer, not "unbuilt").
// Invalidated on every event that can change the answer: a grant or
// revoke, and any account change (sign-in, sign-out, rename), so a grant
// takes effect immediately without a reconnect.
let grantCache: ReadonlySet<string> | null = null;

function invalidateGrantCache(): void {
  grantCache = null;
}

function currentGrantedPeers(): ReadonlySet<string> {
  if (grantCache !== null) return grantCache;
  const record = store().read();
  // Signed out has no grants, even if a stale grants.json lingers under
  // a previous account's id. Signed in, the store's per-account scoping
  // yields an empty list whenever the stored account no longer matches.
  const peers =
    record !== null
      ? new Set(grantStore().list(record.accountId))
      : new Set<string>();
  grantCache = peers;
  return peers;
}

// The predicate the direct listener consults live at dispatch to decide
// whether a peer may run a mutating call on this host. Reads the cached
// granted set, rebuilding it from disk on the first call after an
// invalidation.
export function isPeerCommandGranted(peerDeviceId: string): boolean {
  return currentGrantedPeers().has(peerDeviceId);
}

// The resolved service config, resolved once and cached. Three layers,
// lowest to highest precedence: the optional .env.local file (dev
// convenience), the SM_ACCOUNT_* values baked into the bundle when it
// was built, then real environment variables. The baked layer is what
// configures a shipped build: a packaged .app launched from Finder or
// the Dock inherits launchd's environment, not a shell's, so runtime
// process.env carries none of these -- but the env layer on top still
// lets an owner override a baked build. Caching keeps account:status
// cheap since it runs on every poll.
//
// The web shell reads the same .env.local through Vite, so the filename
// is shared: changing it here strands vite.web.config.ts.
//
// The file read is gated behind !app.isPackaged for security: in a
// packaged build an attacker-planted .env.local in the launch directory
// could both enable sign-in and point the Clerk key/relay URL at hostile
// infrastructure, so a shipped build sources config ONLY from the values
// baked in at build time and real environment variables, neither of
// which a file can plant. The dev-convenience file stays in dev.
function serviceConfig(): AccountServiceConfig {
  if (cachedConfig) return cachedConfig;
  let fileEnv: Record<string, string> = {};
  if (!app.isPackaged) {
    try {
      fileEnv = parseDotenv(
        readFileSync(join(process.cwd(), ".env.local"), "utf8"),
      );
    } catch {
      // No dev file. Baked and environment values are the only sources.
    }
  }
  // __SM_ACCOUNT_BAKED_ENV__ is the vite.node.config.ts define. This
  // module only ever loads through that build, so a bare reference is
  // safe, and it stays out of the pure shared module so serviceConfig.ts
  // remains drivable under plain node (scripts/check-account.mjs).
  cachedConfig = resolveServiceConfig(
    mergeServiceEnv(fileEnv, __SM_ACCOUNT_BAKED_ENV__, process.env),
  );
  return cachedConfig;
}

// The default name a not-yet-renamed device enrolls under.
function defaultDeviceName(): string {
  return hostname();
}

// Whether this build has an account service at all, for callers outside
// the account module (liveness gates keepReachable on it: with no
// account to stay available to, the toggle is unreachable in the UI and
// must be inert in the engine). Uses the same resolver as account:status
// so dev's .env.local file counts.
export function accountServiceConfigured(): boolean {
  return isConfigured(serviceConfig());
}

// The renderer's half of the Clerk mount decision: the resolved
// publishable key rides the window's argv (main/index.ts) so the
// provider can mount synchronously at boot. Empty when unconfigured.
export function clerkPublishableKey(): string {
  return serviceConfig().publishableKey;
}

// Assembles the current status from the stored credential metadata and
// the resolved config. accountId and the stored deviceName come from the
// record when signed in, else empty and the hostname default.
function readStatus(): AccountStatus {
  const config = serviceConfig();
  const record = store().read();
  return {
    configured: isConfigured(config),
    signedIn: record !== null,
    accountId: record?.accountId ?? "",
    deviceName: record?.deviceName ?? defaultDeviceName(),
  };
}

// The signed-in preamble most account-backed calls share: the resolved
// service against the configured relay plus the stored credential
// record. Null when the build is unconfigured or no credential is
// stored, which every caller reads as its own flavor of "nothing to
// do". Kept module private so the store and config stay private too.
function signedInService(): {
  service: AccountService;
  record: StoredAccount;
} | null {
  const config = serviceConfig();
  if (!isConfigured(config)) return null;
  const record = store().read();
  if (record === null) return null;
  return {
    service: createAccountService({ baseUrl: config.relayUrl }),
    record,
  };
}

// The configured web client origin (SM_ACCOUNT_WEB_ORIGIN), for the
// direct listener's Origin gate (v2 step 10, slice B): a browser dial
// arriving over the wss tunnel carries the web client's Origin, and
// this is the one extra origin the listener admits. Undefined means
// none is configured.
export function allowedWebOrigin(): string | undefined {
  const origin = serviceConfig().webOrigin;
  return origin === "" ? undefined : origin;
}

// The tunnel provision call for the cloudflared runner (v2 step 10,
// slice B): asks the Worker to point this device's named tunnel at the
// direct listener's current loopback port. Re-reads the stored
// credential per call like mintTicket, so a rotated credential is
// picked up without refresh plumbing. The returned connectorToken is a
// bearer secret the caller must keep in memory only. Throws
// TunnelUnconfiguredError (shared/account/service.ts) when the Worker
// has no tunnel env, which the runner reads as a typed
// "unconfigured", never a retry loop.
export function provisionDeviceTunnel(
  port: number,
): Promise<{ hostname: string; connectorToken: string }> {
  const signedIn = signedInService();
  if (signedIn === null) {
    return Promise.reject(
      new Error("signed out or the account service is not configured"),
    );
  }
  // Bounded so a black-holed route cannot wedge the runner's
  // serialized lifecycle behind a fetch that never settles.
  return signedIn.service.provisionTunnel(
    signedIn.record.credential,
    port,
    AbortSignal.timeout(15_000),
  );
}

// What the relay socket needs from the account layer, kept here so the
// store and config stay module private. Null when unconfigured or
// signed out, which the relay refresh reads as "stop". mintTicket is a
// closure that re-reads the stored credential on every call, so a
// rotated credential is picked up per connect attempt without any
// refresh plumbing.
export function relayConnectInputs(): {
  relayUrl: string;
  accountId: string;
  mintTicket: (signal: AbortSignal) => Promise<string>;
} | null {
  const signedIn = signedInService();
  if (signedIn === null) return null;
  const { service, record } = signedIn;
  return {
    relayUrl: serviceConfig().relayUrl,
    // Identifies the signed-in account so a re-enroll onto a different
    // account forces the relay socket to reconnect (C7). A Clerk
    // session token is always a JWT with a sub, so the stored record
    // always carries a real account id.
    accountId: record.accountId,
    mintTicket: async (signal) => {
      const fresh = store().read();
      if (fresh === null) {
        throw new Error("signed out, no relay credential");
      }
      // The signal aborts the mint on stop and on the dial's mint
      // timeout, so a black-holed route cannot strand the connect (C6).
      return (await service.mintTicket(fresh.credential, signal)).ticket;
    },
  };
}

export function makeAccountHandlers(
  emitChanged: () => void,
  emitGrantsChanged: () => void,
): Handlers<typeof accountContract> {
  // Fires the account-changed fan-out and invalidates the grant cache
  // together, since any account transition (sign-in, sign-out, rename)
  // may change which grants apply (a new account scopes to a different
  // grant list, sign-out drops them all).
  const accountChanged = (): void => {
    invalidateGrantCache();
    emitChanged();
  };
  return {
    status: () => readStatus(),

    enroll: async (token) => {
      // A second concurrent caller rides the first enrollment instead
      // of racing it and rotating the credential twice. This is the
      // authoritative dedupe for the whole app: renderer effects may
      // re-fire, but the credential is a one-per-machine fact.
      if (enrollInFlight) return enrollInFlight;
      enrollInFlight = (async (): Promise<AccountStatus> => {
        const config = serviceConfig();
        await enrollDevice(
          {
            config,
            service: createAccountService({ baseUrl: config.relayUrl }),
            store: store(),
            // The relay device identity is tied to registry.json:
            // getDeviceId mints and persists this root's UUID there, so
            // a registry reset re-enrolls this app as a brand new relay
            // device.
            deviceId: getDeviceId(),
            fallbackDeviceName: defaultDeviceName(),
            // os.platform() is the same value as process.platform,
            // which the linter restricts here. The relay stores it as
            // an opaque label.
            platform: platform(),
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

    signOut: async () => {
      if (signOutInFlight) return signOutInFlight;
      signOutInFlight = (async (): Promise<void> => {
        const config = serviceConfig();
        await signOutDevice({
          config,
          service: createAccountService({ baseUrl: config.relayUrl }),
          store: store(),
          deviceId: getDeviceId(),
          // The failure is swallowed (local sign-out must always land)
          // and logged at most once per session.
          onRevokeFailure: (error) => {
            if (revokeWarned) return;
            revokeWarned = true;
            console.warn(
              "[account] best-effort device revoke on sign-out failed, " +
                "clearing the local credential anyway.",
              error,
            );
          },
        });
        // Drop this host's command grants too, so re-signing into the
        // SAME account does not resurrect the prior grants from a
        // lingering grants.json. accountChanged() below also
        // invalidates the grant cache, so the in-memory mirror is
        // dropped in the same breath.
        grantStore().clear();
        accountChanged();
      })();
      try {
        return await signOutInFlight;
      } finally {
        signOutInFlight = null;
      }
    },

    revokeDevice: async (deviceId) => {
      const signedIn = signedInService();
      // Nothing to revoke against: no credential means no registry.
      // Loud, not silent -- the caller asked to remove a device.
      if (signedIn === null) {
        throw new Error("cannot revoke a device while signed out");
      }
      const { service, record } = signedIn;
      // Not swallowed the way sign-out's best-effort revoke is: a failed
      // call here leaves the device enrolled, and no local state stands
      // in for that, so the renderer must be able to say so.
      await service.revoke(record.credential, deviceId);
      if (deviceId === getDeviceId()) {
        // Self-revoke invalidated our own credential, so drop it now
        // rather than waiting for the relay to refuse the next call.
        // The desktop UI routes this device through Sign out instead
        // (which ends the Clerk session first); this arm exists so the
        // handler is still correct for any other caller.
        store().clear();
        grantStore().clear();
      } else {
        // A device that is no longer on the account cannot be a
        // meaningful grant target, and leaving the entry would silently
        // re-trust the id if it ever re-enrolled under the same uuid.
        grantStore().revoke(record.accountId, deviceId);
      }
      // Both fan-outs: the registry list and this host's granted set
      // each just changed. accountChanged also drops the grant cache,
      // so the direct listener's dispatch predicate sees the removal
      // without a reconnect.
      accountChanged();
      emitGrantsChanged();
    },

    listDevices: async () => {
      const signedIn = signedInService();
      // Signed out or unconfigured has no registry to show.
      if (signedIn === null) return [];
      return signedIn.service.listDevices(signedIn.record.credential);
    },

    setDeviceName: (name) => {
      const record = store().read();
      // Renaming only means something once a credential is stored. Signed
      // out, the name is the hostname default until the next sign-in.
      if (record) {
        store().write({ ...record, deviceName: name });
        accountChanged();
      }
      return readStatus();
    },

    grantCommands: (deviceId) => {
      const record = store().read();
      // A grant is meaningless with no account to scope it to, and would
      // silently write under the empty account. Fail loudly instead.
      if (record === null) {
        throw new Error("cannot grant command access while signed out");
      }
      grantStore().grant(record.accountId, deviceId);
      invalidateGrantCache();
      emitGrantsChanged();
    },

    revokeCommands: (deviceId) => {
      const record = store().read();
      if (record === null) {
        throw new Error("cannot revoke command access while signed out");
      }
      grantStore().revoke(record.accountId, deviceId);
      invalidateGrantCache();
      emitGrantsChanged();
    },

    listGrantedDevices: () => {
      const record = store().read();
      if (record === null) return [];
      return grantStore().list(record.accountId);
    },
  };
}
