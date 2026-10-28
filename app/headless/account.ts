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
import { callFailureOf, errorMessageOf } from "@shigomori/contracts/errors";
import type { AccountStatus } from "@shigomori/contracts/modules/account";
import {
  loginContract,
  type LoginStatus,
} from "@shigomori/contracts/modules/login";
import type { EffectHandlers } from "@shigomori/contracts/types";
import { current as currentPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { applyAccount } from "@host/process/handlers";
import type { HostServices } from "@host/process/services";
import { registerLoopbackContract } from "@host/process/wires";
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
import { log } from "@shared/log";

const call = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: callFailureOf });

const loginStatus = ({ signedIn, deviceName }: AccountStatus): LoginStatus => ({
  signedIn,
  deviceName,
});

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
    devicesListed: () => {},
    acceptsCommands: () => store.read()?.acceptsCommands === true,
    setAcceptsCommands,
    // Commands are refused from the first moment, ahead of the revoke's
    // round trip.
    beforeSignOut: (record) =>
      record.acceptsCommands === true ? setAcceptsCommands(false) : undefined,
    transitions,
    // The revoke is best effort: offline, it is parked for the next
    // start (boot), and this device signs out here anyway.
    onRevokeFailure: (error) =>
      log.warn(
        `[account] the hub didn't take this device's revoke, so it's kept for later: ${errorMessageOf(error)}`,
      ),
  });

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
