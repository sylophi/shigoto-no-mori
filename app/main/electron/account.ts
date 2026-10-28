// The desktop's account: the hub credential's store (safeStorage's
// cipher over userData), the service's config, this device's default
// name and icon, the command switch, and what follows a change. Sign-in
// itself is the renderer's (Clerk's components over the @clerk/electron
// bridge); this only exchanges its session token for the hub device
// credential. The calls are the web's too (shared/account/handlers.ts),
// served by ipc/modules/account.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { CLONED_LOGIN_MARKER } from "@shared/packaging/appName.mts";
import { byPlatform } from "@shigomori/engine/platform";
import { accountContract } from "@shigomori/contracts/modules/account";
import {
  departed,
  withoutPeerState,
} from "@shigomori/contracts/schemas/config";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { host, hostDeviceId } from "../hostProcess";
import { broadcastAll } from "../ipc/register";
import { devProfileSuffix } from "./devProfile";
import { updateClientConfig } from "./clientConfig";
import type { AccountFacts } from "@shigomori/contracts/modules/session";
import {
  createAccountStore,
  type AccountStore,
  type StoreCipher,
} from "@shared/account/credentialFile";
import {
  defaultDesktopDeviceName,
  type DefaultDeviceName,
} from "@shared/account/defaultDeviceName";
import { detectDesktopDeviceShape } from "../core/account/defaultDeviceIcon";
import { retryParkedRevoke } from "@shared/account/enroll";
import type { AccountShell } from "@shared/account/handlers";
import {
  accountFactsOf,
  nukeSignOut,
  serviceConfigOf,
} from "@shared/account/hostShell";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { createAccountService } from "@shared/account/service";
import {
  isConfigured,
  type AccountServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import { envSetting } from "@shared/config";
import { log, warnOnFailure } from "@shared/log";
import { current as currentPlatform } from "@shigomori/engine/platform";

// Built lazily on first handler use, never at import time. This module is
// imported before app "ready" (registerShellHandlers runs before
// main/index.ts's ready handler), and safeStorage.isEncryptionAvailable,
// app.getPath and the dev userData suffix are only reliable once the app
// is ready, which is guaranteed by the time any renderer call lands. A
// main-process caller can come earlier, so store() refuses before ready:
// a store built then would keep a cipher that reads every credential as
// signed out and writes plaintext for the rest of the run.
let cachedStore: AccountStore | null = null;
let cachedConfig: AccountServiceConfig | null = null;
let cipherWarned = false;
let revokeWarned = false;

// The safeStorage-backed cipher. `available` is the OS keychain's
// verdict: when true the credential is encrypted at rest, when false the
// store keeps plaintext (enc:false) so sign-in still works on a machine
// without a keychain. The plaintext fallback is logged once. Linux
// keeps plaintext by design, in the file only its owner can read, as
// ssh keys and gh's tokens are on a server: with no keyring there,
// safeStorage encrypts with a key Chromium hardcodes.
function buildCipher(): StoreCipher {
  const keychain = byPlatform({ darwin: true, linux: false });
  const available = keychain && safeStorage.isEncryptionAvailable();
  if (keychain && !available && !cipherWarned) {
    cipherWarned = true;
    log.warn(
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
  if (!app.isReady()) {
    throw new Error("[account] the credential store was opened before ready");
  }
  return (cachedStore ??= createAccountStore({
    filePath: join(app.getPath("userData"), "account.json"),
    cipher: buildCipher(),
  }));
}

// The switch as the host is told it (the account's facts), which the
// device link's CommandGate holds a peer's gated calls to, and the
// verdict every connectInfo answer reports. Every peer that reaches
// the device link is a device of this account (the connect ticket
// bound it to one), so the answer is the account-wide switch, not a
// per-peer lookup. Signed out, there is no record and nothing is
// accepted.
function acceptsPeerCommands(): boolean {
  return store().read()?.acceptsCommands === true;
}

// The resolved service config (hostShell.ts), resolved once and cached:
// account:status runs on every poll.
function serviceConfig(): AccountServiceConfig {
  return (cachedConfig ??= serviceConfigOf(app.isPackaged));
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
  // A dev profile is a further device on this machine, so its default
  // name says which one it is.
  const name = `${resolved.name}${devProfileSuffix()}`;
  if (!resolved.provisional) settledDefaultName = name;
  return { name, provisional: resolved.provisional };
}

// What this machine looks like (defaultDeviceIcon.ts), the icon it
// enrolls under until its owner picks one. Detected once per process:
// the probes shell out, and the answer cannot change while the app
// runs. It cannot reject (the detector lands on the fallback shape).
let detectedIconInFlight: Promise<DeviceIcon> | null = null;
function detectedDeviceIcon(): Promise<DeviceIcon> {
  detectedIconInFlight ??= detectDesktopDeviceShape();
  return detectedIconInFlight;
}

// Starts both resolves at boot so they overlap window creation instead
// of gating the first status read. Neither can reject, so nothing
// awaits them.
void defaultDeviceName();
void detectedDeviceIcon();

// Whether this build has an account service at all, for callers outside
// the account module (liveness gates keepReachable on it: with no
// account to stay available to, the toggle is unreachable in the UI and
// must be inert in the engine). Uses the same resolver as account:status
// so dev's .env.local file counts.
export function accountServiceConfigured(): boolean {
  return isConfigured(serviceConfig());
}

// Whether this device holds an account credential, for the same
// callers: signed out, there is no account to stay available to
// either, so liveness treats it like an unconfigured build.
export function accountSignedIn(): boolean {
  return accountServiceConfigured() && store().signedIn();
}

// The renderer's half of the Clerk mount decision: the resolved
// publishable key rides the window's argv (main/index.ts) so the
// provider can mount synchronously at boot. Empty when unconfigured.
export function clerkPublishableKey(): string {
  return serviceConfig().publishableKey;
}

// The account as the host is to know it, reported after every change.
export function accountFactsForHost(): AccountFacts | null {
  return accountFactsOf(serviceConfig(), store().read());
}

// Delivers a revoke a sign-out could not (enroll.ts retryParkedRevoke),
// at boot: a device that signed out offline is still on the hub's
// registry until this lands.
export async function retryParkedSignOut(): Promise<void> {
  const config = serviceConfig();
  if (!isConfigured(config)) return;
  await retryParkedRevoke({
    config,
    service: createAccountService({ baseUrl: config.hubUrl }),
    store: store(),
    deviceId: await hostDeviceId(),
  });
}

// The account's changes, one at a time (AccountShell.transitions): the
// calls' and a nuke's sign-out alike.
const transitions = Semaphore.makeUnsafe(1);

// A nuke's sign-out (hostShell.ts), in the account's turn.
export const signOutForNuke = (): Promise<string | null> =>
  Effect.runPromise(
    transitions.withPermit(
      Effect.promise(async () => {
        const config = serviceConfig();
        return nukeSignOut({
          config,
          service: createAccountService({ baseUrl: config.hubUrl }),
          store: store(),
          deviceId: await hostDeviceId(),
        });
      }),
    ),
  );

// Each change of the account's id (a sign-in, a sign-out, a switch),
// which the login item follows (liveness.ts).
const idChanges = Effect.runSync(PubSub.unbounded<void>());
export const accountIdChanges: Stream.Stream<void> =
  Stream.fromPubSub(idChanges);

// What follows a change to the account, under the ids before and after
// it.
async function accountChanged({
  before,
  after,
}: {
  readonly before: string | null;
  readonly after: string | null;
}): Promise<void> {
  // Before the windows are told, since they re-read their config off
  // the push.
  if (departed({ before, after })) {
    await warnOnFailure(
      "[account] dropping the peer-keyed client config failed",
      () => updateClientConfig(withoutPeerState),
    );
  }
  // The host tears down what was the account's and follows it with the
  // hub socket, while the windows re-read the status.
  const applied = Effect.runPromise(host().account(accountFactsForHost()));
  broadcastAll(accountContract, "changed", { accountId: after });
  // An account switch that stays signed in changes the switch's answer
  // too, which `changed` does not refresh.
  broadcastAll(accountContract, "commandAccessChanged", acceptsPeerCommands());
  const told = warnOnFailure(
    "[account] the host's account change failed",
    () => applied,
  );
  // A departure answers once the host has let the account go; any other
  // change once the windows are told, since a host that isn't up hears
  // the account as it starts.
  if (departed({ before, after })) await told;
  else void told;
  if (before !== after) PubSub.publishUnsafe(idChanges, undefined);
}

// The switch flipping goes out on its own push, so the toggle does not
// thrash the account's status and device queries. The host hears it in
// the facts and tells the peers.
function commandAccessChanged(): void {
  broadcastAll(accountContract, "commandAccessChanged", acceptsPeerCommands());
  Effect.runFork(Effect.ignore(host().account(accountFactsForHost())));
}

// The desktop's half of the account calls (shared/account/handlers.ts).
export const desktopAccount: AccountShell = {
  config: serviceConfig,
  store,
  service: (config) => createAccountService({ baseUrl: config.hubUrl }),
  deviceId: () => hostDeviceId(),
  defaultName: defaultDeviceName,
  detectedIcon: detectedDeviceIcon,
  platform: currentPlatform(),
  // --clone-login leaves this beside the token store it copied
  // (scripts/lib/devProfile.mts cloneDevLogin).
  sharedSignIn: () =>
    existsSync(join(app.getPath("userData"), CLONED_LOGIN_MARKER)),
  codeSignIn: envSetting("SHIGOMORI_CODE_SIGN_IN") === "1",
  changed: accountChanged,
  transitions,
  // The registry as the hub last listed it, which the host's mirrors and
  // forwards follow.
  devicesListed: (devices) =>
    void Effect.runFork(
      Effect.ignore(
        host().accountDevices(devices.map((device) => device.deviceId)),
      ),
    ),
  acceptsCommands: acceptsPeerCommands,
  setAcceptsCommands: (enabled) => {
    const record = store().read();
    // The switch lives on the account's record, and with no record
    // there is nothing to keep it on.
    if (record === null) {
      throw new Error("cannot change command access while signed out");
    }
    store().write({ ...record, acceptsCommands: enabled });
    commandAccessChanged();
  },
  // Off from the first moment of the sign-out, ahead of the revoke's
  // round trip: a peer's gated call landing during the revoke must not
  // find it on. The sign-out's clear drops the record with it, so
  // signing back into the same account starts with the switch off.
  beforeSignOut: (record) => {
    if (record.acceptsCommands === true) {
      store().write({ ...record, acceptsCommands: false });
      commandAccessChanged();
    }
  },
  // The failure is swallowed (local sign-out must always land) and
  // logged at most once per session.
  onRevokeFailure: (error) => {
    if (revokeWarned) return;
    revokeWarned = true;
    log.warn(
      "[account] best-effort device revoke on sign-out failed, " +
        "clearing the local credential anyway.",
      error,
    );
  },
};
