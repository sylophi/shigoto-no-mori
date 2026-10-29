// This machine's account, which the headless host keeps itself, having
// no shell around it to keep it: the credential and device key in
// userData's account.json, as plaintext in a file only its owner can
// read (main/electron/account.ts says why), handed to the host as the
// Electron shell hands them (applyAccount). Its changes are the
// desktop's (shared/account/handlers.ts), and signing in is the
// terminal's (`sm login`, the login contract): Clerk's device grant
// (shared/account/deviceGrant.ts), whose access token enrolls this
// device once and is dropped.
import { join } from "node:path";
import {
  callFailureOf,
  errorMessageOf,
  isHubRefusal,
} from "@shigomori/contracts/errors";
import type { AccountStatus } from "@shigomori/contracts/modules/account";
import {
  loginContract,
  type LoginStatus,
} from "@shigomori/contracts/modules/login";
import type { EffectHandlers } from "@shigomori/contracts/types";
import { current as currentPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  listed,
  matchDevices,
  nameOf,
  type Named,
} from "@host/lib/control/plan";
import { applyAccount, noteAccountDevices } from "@host/process/handlers";
import type { HostServices } from "@host/process/services";
import { onHubStatus, registerLoopbackContract } from "@host/process/wires";
import { createAccountStore } from "@shared/account/credentialFile";
import { defaultDesktopDeviceName } from "@shared/account/defaultDeviceName";
import { retryParkedRevoke } from "@shared/account/enroll";
import {
  awaitDeviceGrant,
  startDeviceGrant,
} from "@shared/account/deviceGrant";
import { makeAccountHandlers } from "@shared/account/handlers";
import {
  accountFactsOf,
  nukeSignOut,
  serviceConfigOf,
} from "@shared/account/hostShell";
import { createAccountService } from "@shared/account/service";
import type { HostFacts } from "@shared/hostFacts";
import type { HandlerContext } from "@shared/ipc/transport";
import { credentialRevoked } from "@shared/remote/supervisor";
import { log } from "@shared/log";

const call = <A>(run: (signal: AbortSignal) => Promise<A>) =>
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

// Made before the host starts, since the loopback takes its contracts
// as it starts. The device id comes once the host is up (boot), and a
// call before then waits for it.
export function headlessAccount(facts: HostFacts) {
  const config = serviceConfigOf(facts.packaged);
  let deviceIdIs!: (deviceId: string) => void;
  const deviceIdOf = new Promise<string>((resolve) => {
    deviceIdIs = resolve;
  });
  const service = createAccountService({ baseUrl: config.hubUrl });
  const store = createAccountStore({
    filePath: join(facts.userDataPath, "account.json"),
    cipher: {
      available: false,
      encrypt: (plaintext) => plaintext,
      decrypt: (payload) => payload,
    },
  });
  const transitions = Semaphore.makeUnsafe(1);
  const tellHost = () => applyAccount(accountFactsOf(config, store.read()));

  // The command switch, kept on the account's record.
  const setAcceptsCommands = async (enabled: boolean) => {
    const record = store.read();
    if (record === null) {
      throw new Error("cannot change command access while signed out");
    }
    store.write({ ...record, acceptsCommands: enabled });
    await tellHost();
  };

  const account = makeAccountHandlers({
    config: () => config,
    store: () => store,
    service: () => service,
    deviceId: () => deviceIdOf,
    defaultName: defaultDesktopDeviceName,
    detectedIcon: async () => "server",
    platform: currentPlatform(),
    sharedSignIn: () => false,
    codeSignIn: false,
    changed: tellHost,
    devicesListed: (devices) =>
      noteAccountDevices(devices.map((device) => device.deviceId)),
    acceptsCommands: () => store.read()?.acceptsCommands === true,
    setAcceptsCommands,
    // Commands are refused from the first moment, ahead of the revoke's
    // round trip.
    beforeSignOut: (record) =>
      record.acceptsCommands === true ? setAcceptsCommands(false) : undefined,
    transitions,
    // The revoke is best effort: offline, it is parked for the next
    // start (boot), and this device signs out here anyway. A refusal is
    // a device the hub has let go already.
    onRevokeFailure: (error) => {
      if (isHubRefusal(error)) return;
      log.warn(
        `[account] the hub didn't take this device's revoke, so it's kept for later: ${errorMessageOf(error)}`,
      );
    },
  });

  // Signed out or offline, there is nothing to read until the next.
  const listDevices = () =>
    Promise.resolve()
      .then(() => account.listDevices(undefined, null))
      .catch(() => {});

  // What the device calls take, said for the terminal.
  const signedIn = () => {
    if (store.read() === null) {
      throw new Error("This machine isn't signed in. `login` signs it in.");
    }
  };

  const login: EffectHandlers<
    typeof loginContract,
    HandlerContext,
    HostServices
  > = {
    status: () =>
      call(async () => loginStatus(await account.status(undefined, null))),
    start: () =>
      call(async (signal) => {
        const record = store.read();
        if (record !== null) {
          throw new Error(
            `This machine is signed in already, as ${record.deviceName}. Sign out first.`,
          );
        }
        return startDeviceGrant(config, signal);
      }),
    // Enrolls under the access token once the person approved.
    finish: (code) =>
      call(async (signal) =>
        loginStatus(
          await account.enroll(
            await awaitDeviceGrant(config, code, signal),
            null,
          ),
        ),
      ),
    signOut: () => call(async () => account.signOut(undefined, null)),
    rename: (name) =>
      call(async () => {
        signedIn();
        return loginStatus(
          await account.setDeviceName(
            { deviceId: await deviceIdOf, name },
            null,
          ),
        );
      }),
    setIcon: (icon) =>
      call(async () => {
        signedIn();
        return loginStatus(
          await account.setDeviceIcon(
            { deviceId: await deviceIdOf, icon },
            null,
          ),
        );
      }),
    removeDevice: (query) =>
      call(async () => {
        signedIn();
        const self = await deviceIdOf;
        const peers = (await account.listDevices(undefined, null)).filter(
          (device) => device.deviceId !== self,
        );
        const matched = matchDevices(peers, query).map((device) => ({
          deviceId: device.deviceId,
          name: nameOf(device),
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
        const [device] = matched as [Named];
        await account.revokeDevice(device.deviceId, null);
        // Its mirrors and forwards here end with the listing.
        await listDevices();
        return device.name;
      }),
  };
  registerLoopbackContract(loginContract, login);

  return {
    setAcceptsCommands,
    // The account as this start finds it, and a revoke a sign-out
    // couldn't deliver, delivered now.
    boot: async (deviceId: string) => {
      deviceIdIs(deviceId);
      await tellHost();
      const parked = await retryParkedRevoke({
        config,
        service,
        store,
        deviceId,
      });
      if (parked.kind === "failed") {
        log.warn(
          `[account] a revoke kept from a sign-out still didn't land: ${errorMessageOf(parked.error)}`,
        );
      }
      void listDevices();
      setInterval(() => void listDevices(), LIST_DEVICES_EVERY_MS).unref();
      // Removed from the account, it signs out, as a window does
      // (ClerkAccountSync), so `sm login` can sign it in afresh.
      onHubStatus(({ socket }) => {
        if (!credentialRevoked(socket) || store.read() === null) return;
        void Promise.resolve(account.signOut(undefined, null)).catch(() => {});
      });
    },
    signOutForNuke: async () => {
      const deviceId = await deviceIdOf;
      return Effect.runPromise(
        transitions.withPermit(
          Effect.promise(() =>
            nukeSignOut({ config, service, store, deviceId }),
          ),
        ),
      );
    },
  };
}
