// This machine's account, which the headless host keeps itself, having
// no shell around it: its Colibrii device is the host's, in this process
// (host/process/device.ts), and its profile is userData's account.json.
// Its calls are the desktop's (shared/account/handlers.ts), and signing
// in is the terminal's (`sm login`, the login contract): Clerk's device
// grant, whose access token enrolls this device once and is dropped.
import { join } from "node:path";
import { callFailureOf } from "@shigomori/contracts/errors";
import type { AccountStatus } from "@shigomori/contracts/modules/account";
import type { DeviceAccount } from "@shigomori/contracts/modules/session";
import {
  loginContract,
  type LoginStatus,
} from "@shigomori/contracts/modules/login";
import { current as currentPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  listed,
  matchDevices,
  nameOf,
  type Named,
} from "@host/lib/control/plan";
import { deviceCalls } from "@host/process/device";
import { noteAcceptsCommands } from "@host/process/handlers";
import * as HostRpc from "@host/socket/hostRpc";
import { defaultDesktopDeviceName } from "@shared/account/defaultDeviceName";
import {
  accessTokenFor,
  accountIdOf,
  makeAccountHandlers,
  startCodeSignIn,
} from "@shared/account/handlers";
import { nukeSignOut, serviceConfigOf } from "@shared/account/hostShell";
import { profileFile } from "@shared/account/profileFile";
import type { HostFacts } from "@shared/hostFacts";

const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: callFailureOf });

// How often a host with no window reads the account's devices, which a
// window does as it comes into focus: a device removed from the account
// ends its mirrors and forwards here, and a peer's rename of this one
// lands.
const LIST_DEVICES_EVERY_MS = 10 * 60_000;

const loginStatus = ({
  signedIn,
  deviceName,
  deviceIcon,
}: AccountStatus): LoginStatus => ({ signedIn, deviceName, deviceIcon });

// What the device calls take, said for the terminal.
const signedIn = async () => {
  if (accountIdOf(await deviceCalls.account()) === null) {
    throw new Error("This machine isn't signed in. `login` signs it in.");
  }
};

export type HeadlessAccount = ReturnType<typeof headlessAccount>;

// Made before the host starts, since the loopback takes its contracts
// as it starts. The device id comes once the host is up (boot), and a
// call before then waits for it.
export function headlessAccount(facts: HostFacts) {
  const config = serviceConfigOf(facts.packaged);
  let deviceIdIs!: (deviceId: string) => void;
  const deviceIdOf = new Promise<string>((resolve) => {
    deviceIdIs = resolve;
  });
  const profile = profileFile(join(facts.userDataPath, "account.json"));

  // The host holds the switch against the account it is on.
  void noteAcceptsCommands(profile.read().acceptsCommandsFor ?? null);

  const account = makeAccountHandlers({
    config: () => config,
    device: deviceCalls,
    profile: () => profile,
    deviceId: () => deviceIdOf,
    defaultName: defaultDesktopDeviceName,
    detectedIcon: async () => "server",
    platform: currentPlatform(),
    sharedSignIn: () => false,
    codeSignIn: false,
    changed: () => {},
    acceptsCommandsChanged: (accountId) => noteAcceptsCommands(accountId),
  });

  // Signed out or offline, there is nothing to read until the next.
  const listDevices = () =>
    Promise.resolve()
      .then(() => account.listDevices(undefined, null))
      .catch(() => {});

  const login = HostRpc.handlers(loginContract, {
    status: () =>
      call(async () => loginStatus(await account.status(undefined, null))),
    start: () =>
      call(async () => {
        const status = await account.status(undefined, null);
        if (status.signedIn) {
          throw new Error(
            `This machine is signed in already, as ${status.deviceName}. Sign out first.`,
          );
        }
        return Effect.runPromise(startCodeSignIn(config));
      }),
    // Enrolls under the access token once the person approved. A
    // terminal that goes away while it waits stops the wait with it.
    finish: (code) =>
      accessTokenFor(config, code).pipe(
        Effect.mapError(callFailureOf),
        Effect.flatMap((accessToken) =>
          call(async () =>
            loginStatus(await account.enroll(accessToken, null)),
          ),
        ),
      ),
    signOut: () => call(async () => account.signOut(undefined, null)),
    rename: (name) =>
      call(async () => {
        await signedIn();
        return loginStatus(
          await account.setDeviceName(
            { deviceId: await deviceIdOf, name },
            null,
          ),
        );
      }),
    setIcon: (icon) =>
      call(async () => {
        await signedIn();
        return loginStatus(
          await account.setDeviceIcon(
            { deviceId: await deviceIdOf, icon },
            null,
          ),
        );
      }),
    removeDevice: (query) =>
      call(async () => {
        await signedIn();
        const self = await deviceIdOf;
        const peers = (await account.listDevices(undefined, null)).filter(
          (peer) => peer.deviceId !== self,
        );
        const matched = matchDevices(peers, query).map((peer) => ({
          deviceId: peer.deviceId,
          name: nameOf(peer),
        }));
        if (matched.length === 0) {
          throw new Error(
            `No other device on the account goes by "${query}". \`devices\` lists them.`,
          );
        }
        if (matched.length > 1) {
          throw new Error(
            `"${query}" picks ${listed(matched)}. Give more of the name or its id.`,
          );
        }
        const [removed] = matched as [Named];
        await account.revokeDevice(removed.deviceId, null);
        return removed.name;
      }),
  });

  return {
    // The login contract, which the loopback serves.
    login,
    setAcceptsCommands: (enabled: boolean) =>
      account.setAcceptsCommands(enabled, null),
    // Removed from the account, it signs out, as a window does
    // (ClerkAccountSync): its command switch goes with it, so `sm login`
    // signs it in with commands off.
    accountReported: (state: DeviceAccount) => {
      if (!Predicate.isTagged(state, "SignedOut") || !state.removed) return;
      void Promise.resolve(account.signOut(undefined, null)).catch(() => {});
    },
    boot: (deviceId: string) => {
      deviceIdIs(deviceId);
      void listDevices();
      setInterval(() => void listDevices(), LIST_DEVICES_EVERY_MS).unref();
    },
    signOutForNuke: () => nukeSignOut(deviceCalls),
  };
}
