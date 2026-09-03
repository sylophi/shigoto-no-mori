// The one electron-facing file of the hub account layer. Everything
// under main/account/ is pure and electron-free so the account check
// script can drive it. This module is where electron enters: safeStorage
// builds the at-rest cipher, app names the userData store path, and
// process.env supplies the service config. Sign-in itself lives in the
// renderer (Clerk's embedded components over the @clerk/electron
// bridge). This module only exchanges the resulting session token for
// the hub device credential. The handlers stay thin, delegating to
// the pure orchestration.
import { readFileSync } from "node:fs";
import { platform } from "node:os";
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
import {
  defaultDesktopDeviceName,
  isLegacyDefaultName,
  type DefaultDeviceName,
} from "../../account/defaultDeviceName";
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
      "[account] OS encryption unavailable, storing the hub credential " +
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

// The command-access store, plaintext in userData (the switch is not a
// bearer secret, see grantStore.ts). Built lazily for the same
// app-ready reason as the credential store.
function grantStore(): GrantStore {
  if (cachedGrantStore) return cachedGrantStore;
  cachedGrantStore = createGrantStore({
    filePath: join(app.getPath("userData"), "grants.json"),
  });
  return cachedGrantStore;
}

// In-memory mirror of the command-access switch for the CURRENT
// account, so the direct listener's synchronous dispatch predicate
// (acceptsPeerCommands) never hits the disk or the OS keychain on the
// hot path. Null means not yet built (false is a real built answer,
// not "unbuilt"). Invalidated on every event that can change the
// answer: the switch flipping, and any account change (sign-in,
// sign-out, rename), so a flip takes effect immediately without a
// reconnect.
let grantCache: boolean | null = null;

function invalidateGrantCache(): void {
  grantCache = null;
}

// The predicate the direct listener consults live at dispatch to decide
// whether a peer may run a mutating call on this host. Every peer that
// reaches the direct listener is a device of this account (the connect
// ticket bound it to one), so the answer is the account-wide switch,
// not a per-peer lookup. Reads the cached answer, rebuilding it from
// disk on the first call after an invalidation.
export function acceptsPeerCommands(): boolean {
  if (grantCache !== null) return grantCache;
  const record = store().read();
  // Signed out accepts nothing, even if a stale grants.json lingers
  // under a previous account's id. Signed in, the store's per-account
  // scoping reads as off whenever the stored account no longer matches.
  grantCache = record !== null && grantStore().enabled(record.accountId);
  return grantCache;
}

// The resolved service config, resolved once and cached. Three layers,
// lowest to highest precedence: the optional .env.local file (dev
// convenience), the account service values baked into the bundle when
// it was built, then real environment variables. The baked layer is
// what configures a shipped build: a packaged .app launched from Finder
// or the Dock inherits launchd's environment, not a shell's, so runtime
// process.env carries none of these -- but the env layer on top still
// lets an owner override a baked build. Caching keeps account:status
// cheap since it runs on every poll.
//
// The web shell reads the same .env.local through Vite, so the filename
// is shared: changing it here strands vite.web.config.ts.
//
// The file read is gated behind !app.isPackaged for security: in a
// packaged build an attacker-planted .env.local in the launch directory
// could both enable sign-in and point the Clerk key/hub URL at hostile
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

// The default name a not-yet-renamed device enrolls under. The macOS
// half shells out (defaultDeviceName.ts), asynchronously so a status
// read never blocks main on the child. A settled answer is kept for
// the process. A provisional one (scutil did not answer this time) is
// served but not kept, so the next read asks again.
let settledDefaultName: string | null = null;
let defaultNameInFlight: Promise<DefaultDeviceName> | null = null;
async function defaultDeviceName(): Promise<DefaultDeviceName> {
  if (settledDefaultName !== null) {
    return { name: settledDefaultName, provisional: false };
  }
  defaultNameInFlight ??= defaultDesktopDeviceName().finally(() => {
    defaultNameInFlight = null;
  });
  const resolved = await defaultNameInFlight;
  if (!resolved.provisional) settledDefaultName = resolved.name;
  return resolved;
}

// Starts the resolve at boot so it overlaps window creation instead of
// gating the first status read. It cannot reject (the resolver falls
// back to the hostname), so nothing awaits it.
void defaultDeviceName();

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

// Assembles the status from the stored credential metadata and the
// resolved config. accountId and the stored deviceName come from the
// record when signed in, else empty and the machine's default name.
function statusOf(
  record: StoredAccount | null,
  defaultName: string,
): AccountStatus {
  return {
    configured: isConfigured(serviceConfig()),
    signedIn: record !== null,
    accountId: record?.accountId ?? "",
    deviceName: record?.deviceName ?? defaultName,
  };
}

async function readStatus(): Promise<AccountStatus> {
  return statusOf(store().read(), (await defaultDeviceName()).name);
}

// The signed-in preamble most account-backed calls share: the resolved
// service against the configured hub plus the stored credential
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
    service: createAccountService({ baseUrl: config.hubUrl }),
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

// What the hub socket needs from the account layer, kept here so the
// store and config stay module private. Null when unconfigured or
// signed out, which the hub refresh reads as "stop". mintTicket is a
// closure that re-reads the stored credential on every call, so a
// rotated credential is picked up per connect attempt without any
// refresh plumbing.
export function hubConnectInputs(): {
  hubUrl: string;
  accountId: string;
  mintTicket: (signal: AbortSignal) => Promise<string>;
} | null {
  const signedIn = signedInService();
  if (signedIn === null) return null;
  const { service, record } = signedIn;
  return {
    hubUrl: serviceConfig().hubUrl,
    // Identifies the signed-in account so a re-enroll onto a different
    // account forces the hub socket to reconnect (C7). A Clerk
    // session token is always a JWT with a sub, so the stored record
    // always carries a real account id.
    accountId: record.accountId,
    mintTicket: async (signal) => {
      const fresh = store().read();
      if (fresh === null) {
        throw new Error("signed out, no hub credential");
      }
      // The signal aborts the mint on stop and on the dial's mint
      // timeout, so a black-holed route cannot strand the connect (C6).
      return (await service.mintTicket(fresh.credential, signal)).ticket;
    },
  };
}

export function makeAccountHandlers(
  emitChanged: () => void,
  emitCommandAccessChanged: () => void,
): Handlers<typeof accountContract> {
  // Fires the account-changed fan-out and invalidates the grant cache
  // together, since any account transition (sign-in, sign-out, rename)
  // may change the answer (a new account scopes to its own switch,
  // sign-out turns it off).
  const accountChanged = (): void => {
    invalidateGrantCache();
    emitChanged();
  };
  // A device enrolled before the default learned to drop the hostname's
  // domain (and to prefer the macOS computer name) still stores the raw
  // hostname, "Name.local" on a Mac. A stored name that IS the raw
  // hostname was never chosen by anyone, so it follows the default
  // forward, once per process, the first time status is read while
  // signed in with a SETTLED default (a provisional one would bake the
  // hostname stand-in in for good) -- through the same fan-out a rename
  // takes, so every window sees the new name. The device hub keeps the
  // name a device enrolled under (there is no rename call), so peers
  // see it after the next enrollment, like any rename. A name the user
  // typed cannot match the raw hostname unless they typed exactly that,
  // in which case the default is what they asked for. Returns the
  // record status should report. A write that fails leaves the old
  // name, since a cosmetic rename must never turn a status read into
  // an error.
  let defaultNameMigrated = false;
  const migrateDefaultName = (
    record: StoredAccount | null,
    defaultName: DefaultDeviceName,
  ): StoredAccount | null => {
    if (defaultNameMigrated || record === null || defaultName.provisional) {
      return record;
    }
    defaultNameMigrated = true;
    if (
      !isLegacyDefaultName(record.deviceName) ||
      record.deviceName === defaultName.name
    ) {
      return record;
    }
    const renamed = { ...record, deviceName: defaultName.name };
    try {
      store().write(renamed);
    } catch (error) {
      console.warn(
        "[account] could not rename the device to its default",
        error,
      );
      return record;
    }
    accountChanged();
    return renamed;
  };
  return {
    status: async () => {
      const defaultName = await defaultDeviceName();
      return statusOf(
        migrateDefaultName(store().read(), defaultName),
        defaultName.name,
      );
    },

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
            service: createAccountService({ baseUrl: config.hubUrl }),
            store: store(),
            // The hub device identity is tied to registry.json:
            // getDeviceId mints and persists this root's UUID there, so
            // a registry reset re-enrolls this app as a brand new hub
            // device.
            deviceId: getDeviceId(),
            fallbackDeviceName: (await defaultDeviceName()).name,
            // os.platform() is the same value as process.platform,
            // which the linter restricts here. The device hub stores it
            // as an opaque label.
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
          service: createAccountService({ baseUrl: config.hubUrl }),
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
        // Drop this host's command-access switch too, so re-signing
        // into the SAME account does not resurrect it from a lingering
        // grants.json. accountChanged() below also invalidates the
        // grant cache, so the in-memory mirror is dropped in the same
        // breath.
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
        // rather than waiting for the device hub to refuse the next
        // call. The desktop UI routes this device through Sign out
        // instead (which ends the Clerk session first). This arm exists
        // so the handler is still correct for any other caller.
        store().clear();
        grantStore().clear();
      }
      // accountChanged also drops the grant cache, so a self-revoke's
      // cleared switch is what the direct listener's dispatch predicate
      // reads next, without a reconnect.
      accountChanged();
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

    acceptsCommands: acceptsPeerCommands,

    setAcceptsCommands: (enabled) => {
      const record = store().read();
      // The switch is meaningless with no account to scope it to, and
      // would silently write under the empty account. Fail loudly
      // instead.
      if (record === null) {
        throw new Error("cannot change command access while signed out");
      }
      grantStore().set(record.accountId, enabled);
      // The answer just written IS the cache, for the account the
      // record names: the renderer's refetch off the fan-out must not
      // cost another keychain decrypt to learn it.
      grantCache = enabled;
      emitCommandAccessChanged();
    },
  };
}
