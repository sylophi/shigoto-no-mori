// This machine's account, which the headless host keeps itself, having
// no shell around it: its Colibrii device is the host's, in this process
// (host/process/device.ts), and its profile is userData's account.json.
// Its calls are the desktop's (shared/account/handlers.ts), and signing
// in is the terminal's (`sm login`, the login contract): Clerk's device
// grant, whose access token enrolls this device once and is dropped.
import { join } from "node:path";
import * as Colibrii from "@colibrii/sdk";
import { callFailureOf } from "@shigomori/contracts/errors";
import type { AccountStatus } from "@shigomori/contracts/modules/account";
import {
  loginContract,
  type LoginStatus,
} from "@shigomori/contracts/modules/login";
import type { DeviceAccount } from "@shigomori/contracts/modules/session";
import { current as currentPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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
  accountIdOf,
  type DevicePort,
  makeAccountHandlers,
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

export type HeadlessAccount = ReturnType<typeof headlessAccount>;

// The device's calls, in this process.
const device: DevicePort = {
  account: deviceCalls.account,
  enroll: deviceCalls.enroll,
  signOut: deviceCalls.signOut,
  list: deviceCalls.listDevices,
  rename: (deviceId, name) => deviceCalls.renameDevice({ deviceId, name }),
  setData: (deviceId, data) => deviceCalls.setDeviceData({ deviceId, data }),
  remove: deviceCalls.removeDevice,
};

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

  const account = makeAccountHandlers({
    config: () => config,
    device,
    profile: () => profile,
    deviceId: () => deviceIdOf,
    defaultName: defaultDesktopDeviceName,
    detectedIcon: async () => "server",
    platform: currentPlatform(),
    sharedSignIn: () => false,
    codeSignIn: false,
    renamed: () => {},
    acceptsCommandsChanged: (accountId) => noteAcceptsCommands(accountId),
  });

  // Signed out or offline, there is nothing to read until the next.
  const listDevices = () =>
    Promise.resolve()
      .then(() => account.listDevices(undefined, null))
      .catch(() => {});

  // What the device calls take, said for the terminal.
  const signedIn = async () => {
    if (accountIdOf(await device.account()) === null) {
      throw new Error("This machine isn't signed in. `login` signs it in.");
    }
  };

  const codeOptions = () => {
    if (config.oauthClientId === "") {
      throw new Error("This build has no OAuth client to sign in with.");
    }
    return {
      publishableKey: config.publishableKey,
      clientId: config.oauthClientId,
    };
  };

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
        const { verificationUriComplete, ...code } = await Effect.runPromise(
          Colibrii.startCodeSignIn(codeOptions()).pipe(
            Effect.provide(FetchHttpClient.layer),
          ),
        );
        return {
          ...code,
          ...(verificationUriComplete === undefined
            ? {}
            : { verificationUriComplete }),
        };
      }),
    // Enrolls under the access token once the person approved. A
    // terminal that goes away while it waits stops the wait with it.
    finish: (code) =>
      Effect.try({ try: codeOptions, catch: callFailureOf }).pipe(
        Effect.flatMap((options) =>
          Colibrii.finishCodeSignIn(options, {
            ...code,
            verificationUriComplete: code.verificationUriComplete,
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.mapError(callFailureOf),
          ),
        ),
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
        // Its mirrors and forwards here end with the listing.
        await listDevices();
        return removed.name;
      }),
  });

  // The account the device is on, as the host reports it: the switch
  // for it goes back to the host's gates.
  let reported: string | null | undefined;
  const changed = async (state: DeviceAccount) => {
    const accountId = accountIdOf(state);
    if (accountId === reported) return;
    reported = accountId;
    await noteAcceptsCommands(
      accountId !== null && profile.read().acceptsCommandsFor === accountId
        ? accountId
        : null,
    );
  };

  return {
    // The login contract, which the loopback serves.
    login,
    setAcceptsCommands: (enabled: boolean) =>
      account.setAcceptsCommands(enabled, null),
    changed,
    boot: (deviceId: string) => {
      deviceIdIs(deviceId);
      void listDevices();
      setInterval(() => void listDevices(), LIST_DEVICES_EVERY_MS).unref();
    },
    signOutForNuke: () => nukeSignOut(device),
  };
}
