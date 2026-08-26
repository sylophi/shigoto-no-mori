// The one electron-facing file of the relay account layer. Everything
// under main/account/ is pure and electron-free so the account check
// script can drive it. This module is where electron enters: safeStorage
// builds the at-rest cipher, shell opens the OAuth browser, app names the
// userData store path, and process.env supplies the service config. The
// handlers themselves stay thin, delegating to the pure orchestration.
import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { app, safeStorage, shell } from "electron";
import { accountContract } from "@shared/ipc/modules/account";
import type { AccountStatus } from "@shared/ipc/modules/account";
import type { Handlers } from "@shared/ipc/types";
import { getDeviceId } from "@host/lib/config/deviceId";
import {
  createAccountStore,
  type AccountStore,
  type StoreCipher,
} from "../../account/credentialStore";
import { runLoginFlow } from "../../account/login";
import { createAccountService } from "../../account/service";
import {
  isConfigured,
  mergeServiceEnv,
  parseDotenv,
  resolveServiceConfig,
  type AccountServiceConfig,
} from "../../account/serviceConfig";

// Built lazily on first handler use, never at import time. This module is
// imported before app "ready" (registerIpcHandlers runs at the top of
// main/index.ts), and safeStorage.isEncryptionAvailable, app.getPath and
// the dev userData suffix are only reliable once the app is ready, which
// is guaranteed by the time any renderer call lands.
let cachedStore: AccountStore | null = null;
let cachedConfig: AccountServiceConfig | null = null;
let cipherWarned = false;
let revokeWarned = false;
// Re-entrancy guard for account:signIn. A concurrent invocation (two
// windows, a rapid re-invoke) must not start two loopback servers or two
// browser tabs, so the second caller rides this in-flight promise.
let signInInFlight: Promise<AccountStatus> | null = null;

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

// The resolved service config, resolved once and cached. Reads the
// optional .env.account file (dev convenience) first, then lets real
// environment variables override it, so a shipped build with real env
// vars never depends on a file. Caching keeps account:status cheap since
// it runs on every poll.
//
// The file read is gated behind !app.isPackaged for security: in a
// packaged build an attacker-planted .env.account in the launch directory
// could both enable sign-in and point the OAuth/relay URLs at hostile
// infrastructure, so a shipped build sources config ONLY from real
// environment variables. The dev-convenience file stays in dev.
function serviceConfig(): AccountServiceConfig {
  if (cachedConfig) return cachedConfig;
  let fileEnv: Record<string, string> = {};
  if (!app.isPackaged) {
    try {
      fileEnv = parseDotenv(
        readFileSync(join(process.cwd(), ".env.account"), "utf8"),
      );
    } catch {
      // No dev file. Environment variables are the only source.
    }
  }
  cachedConfig = resolveServiceConfig(mergeServiceEnv(fileEnv, process.env));
  return cachedConfig;
}

// The default name a not-yet-renamed device enrolls under.
function defaultDeviceName(): string {
  return hostname();
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

export function makeAccountHandlers(
  emitChanged: () => void,
): Handlers<typeof accountContract> {
  return {
    status: () => readStatus(),

    signIn: async () => {
      // A second concurrent caller rides the first flow instead of
      // opening its own loopback server and browser tab.
      if (signInInFlight) return signInInFlight;
      signInInFlight = (async (): Promise<AccountStatus> => {
        const config = serviceConfig();
        if (!isConfigured(config)) {
          throw new Error(
            "the relay account service is not configured on this build",
          );
        }
        const service = createAccountService({ baseUrl: config.relayUrl });
        await runLoginFlow({
          config,
          // The relay device identity is tied to registry.json: getDeviceId
          // mints and persists this root's UUID there, so a registry reset
          // re-enrolls this app as a brand new relay device.
          deviceId: getDeviceId(),
          deviceName: store().read()?.deviceName ?? defaultDeviceName(),
          // os.platform() is the same value as process.platform, which the
          // linter restricts here. The relay stores it as an opaque label.
          platform: platform(),
          openBrowser: (url) => shell.openExternal(url),
          service,
          store: store(),
        });
        emitChanged();
        return readStatus();
      })();
      try {
        return await signInInFlight;
      } finally {
        signInInFlight = null;
      }
    },

    signOut: async () => {
      const config = serviceConfig();
      const record = store().read();
      // Best-effort server-side revoke of THIS device before clearing
      // locally, so a signed-out device's credential does not stay valid
      // on the relay. Any failure (offline, relay down, non-2xx) is
      // swallowed and logged at most once, because local sign-out MUST
      // always succeed regardless.
      if (record && isConfigured(config)) {
        try {
          const service = createAccountService({ baseUrl: config.relayUrl });
          await service.revoke(record.credential, getDeviceId());
        } catch (error) {
          if (!revokeWarned) {
            revokeWarned = true;
            console.warn(
              "[account] best-effort device revoke on sign-out failed, " +
                "clearing the local credential anyway.",
              error,
            );
          }
        }
      }
      store().clear();
      emitChanged();
    },

    listDevices: async () => {
      const config = serviceConfig();
      const record = store().read();
      // Signed out or unconfigured has no registry to show.
      if (!record || !isConfigured(config)) return [];
      const service = createAccountService({ baseUrl: config.relayUrl });
      return service.listDevices(record.credential);
    },

    setDeviceName: (name) => {
      const record = store().read();
      // Renaming only means something once a credential is stored. Signed
      // out, the name is the hostname default until the next sign-in.
      if (record) {
        store().write({ ...record, deviceName: name });
        emitChanged();
      }
      return readStatus();
    },
  };
}
