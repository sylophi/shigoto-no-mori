// The desktop's account: its Colibrii device lives in the host
// (host/lib/PeerDevice.ts), whose session calls this reaches it by. Kept
// here: the profile (shared/account/profile.ts) in userData, the key the
// host's store is sealed with under safeStorage, the service's config,
// this device's default name and icon, and what follows a change.
// Sign-in itself is the renderer's (Clerk's components over the
// @clerk/electron bridge). The calls are the web's too
// (shared/account/handlers.ts), served by ipc/handlers.ts.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { CLONED_LOGIN_MARKER } from "@shared/packaging/appName.mts";
import { byPlatform } from "@shigomori/engine/platform";
import { accountContract } from "@shigomori/contracts/modules/account";
import {
  departed,
  withoutPeerState,
} from "@shigomori/contracts/schemas/config";
import type { DeviceAccount } from "@shigomori/contracts/modules/session";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { host, hostDeviceId } from "../hostProcess";
import { broadcastAll } from "../ipc/register";
import { devProfileSuffix } from "./devProfile";
import { updateClientConfig } from "./clientConfig";
import {
  defaultDesktopDeviceName,
  type DefaultDeviceName,
} from "@shared/account/defaultDeviceName";
import { detectDesktopDeviceShape } from "../core/account/defaultDeviceIcon";
import {
  accountIdOf,
  type AccountShell,
  type DevicePort,
  makeAccountHandlers,
  switchFor,
} from "@shared/account/handlers";
import { nukeSignOut, serviceConfigOf } from "@shared/account/hostShell";
import type { ProfileStore } from "@shared/account/profile";
import { profileFile } from "@shared/account/profileFile";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import {
  isConfigured,
  type AccountServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import { envSetting } from "@shared/config";
import { log, warnOnFailure } from "@shared/log";
import { current as currentPlatform } from "@shigomori/engine/platform";

// Built lazily, never at import time: app.getPath and the dev userData
// suffix are only reliable once the app is ready, which is guaranteed by
// the time any call lands.
let cachedProfile: ProfileStore | null = null;
let cachedConfig: AccountServiceConfig | null = null;

function profile(): ProfileStore {
  return (cachedProfile ??= profileFile(
    join(app.getPath("userData"), "account.json"),
  ));
}

// The resolved service config (hostShell.ts), resolved once and cached:
// account:status runs on every poll.
function serviceConfig(): AccountServiceConfig {
  return (cachedConfig ??= serviceConfigOf(app.isPackaged));
}

// The key the host's Colibrii store is sealed with, kept sealed by the
// OS keychain beside it. Linux keeps none by design: with no keyring
// there, safeStorage encrypts with a key Chromium hardcodes, so the
// store is a file only its owner can read, as ssh keys and gh's tokens
// are on a server. A key that no longer opens is replaced, and the
// device enrolls again.
const STORE_KEY_FILE = "device-store-key";
let storeKeyWarned = false;
export function deviceStoreKey(): string | null {
  const keychain = byPlatform({ darwin: true, linux: false, win32: true });
  if (!keychain) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    if (!storeKeyWarned) {
      storeKeyWarned = true;
      log.warn(
        "[account] OS encryption unavailable, keeping this device's enrollment as plaintext in userData.",
      );
    }
    return null;
  }
  const path = join(app.getPath("userData"), STORE_KEY_FILE);
  try {
    return safeStorage.decryptString(readFileSync(path));
  } catch {
    const key = randomBytes(32).toString("base64");
    writeFileSync(path, safeStorage.encryptString(key), { mode: 0o600 });
    return key;
  }
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

// The device's account as the host last reported it, null before its
// first report.
let reported: DeviceAccount | null = null;

// Whether this device is on an account, for the same callers: signed
// out, there is no account to stay available to either, so liveness
// treats it like an unconfigured build.
export function accountSignedIn(): boolean {
  return reported !== null && accountIdOf(reported) !== null;
}

// The renderer's half of the Clerk mount decision: the resolved
// publishable key rides the window's argv (main/index.ts) so the
// provider can mount synchronously at boot. Empty when unconfigured.
export function clerkPublishableKey(): string {
  return serviceConfig().publishableKey;
}

// The account the command switch is on for, as the host is told it at
// its start: the host holds it against the account it is on.
export function commandSwitchForHost(): string | null {
  return profile().read().acceptsCommandsFor ?? null;
}

// The device's calls, on the host.
const device: DevicePort = {
  account: () => Effect.runPromise(host().account()),
  enroll: (input) => Effect.runPromise(host().enroll(input)),
  signOut: () => Effect.runPromise(host().signOut()),
  list: () => Effect.runPromise(host().listDevices()),
  rename: (deviceId, name) =>
    Effect.runPromise(host().renameDevice({ deviceId, name })),
  setData: (deviceId, data) =>
    Effect.runPromise(host().setDeviceData({ deviceId, data })),
  remove: (deviceId) => Effect.runPromise(host().removeDevice(deviceId)),
};

// A nuke's sign-out (hostShell.ts).
export const signOutForNuke = (): Promise<string | null> => nukeSignOut(device);

// Each change of the account's id (a sign-in, a sign-out, a switch),
// which the login item follows (liveness.ts).
const idChanges = Effect.runSync(PubSub.unbounded<void>());
export const accountIdChanges: Stream.Stream<void> =
  Stream.fromPubSub(idChanges);

// The device's account as the host reports it, at its start and on
// every change. A change of account drops the client config's peer
// state on a departure, before the windows re-read their config off the
// push.
export async function accountReported(state: DeviceAccount): Promise<void> {
  const known = reported;
  reported = state;
  const after = accountIdOf(state);
  const before = known === null ? after : accountIdOf(known);
  if (known !== null && before === after) return;
  if (departed({ before, after })) {
    await warnOnFailure(
      "[account] dropping the peer-keyed client config failed",
      () => updateClientConfig(withoutPeerState),
    );
  }
  broadcastAll(accountContract, "changed", { accountId: after });
  // An account switch that stays signed in changes the switch's answer
  // too, which `changed` does not refresh.
  broadcastAll(
    accountContract,
    "commandAccessChanged",
    switchFor(profile().read(), state) !== null,
  );
  if (before !== after) PubSub.publishUnsafe(idChanges, undefined);
}

const desktopAccount: AccountShell = {
  config: serviceConfig,
  device,
  profile,
  deviceId: () => hostDeviceId(),
  defaultName: defaultDeviceName,
  detectedIcon: detectedDeviceIcon,
  platform: currentPlatform(),
  // --clone-login leaves this beside the token store it copied
  // (scripts/lib/devProfile.mts cloneDevLogin).
  sharedSignIn: () =>
    existsSync(join(app.getPath("userData"), CLONED_LOGIN_MARKER)),
  codeSignIn: envSetting("SHIGOMORI_CODE_SIGN_IN") === "1",
  renamed: () =>
    broadcastAll(accountContract, "changed", {
      accountId: reported === null ? null : accountIdOf(reported),
    }),
  // The host hears it for its peers' gates, and the windows for the
  // toggle.
  acceptsCommandsChanged: async (accountId) => {
    broadcastAll(accountContract, "commandAccessChanged", accountId !== null);
    await Effect.runPromise(host().acceptsCommands(accountId));
  },
};

// The desktop's account calls (shared/account/handlers.ts).
export const accountHandlers = makeAccountHandlers(desktopAccount);
