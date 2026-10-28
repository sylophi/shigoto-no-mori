// This machine's account, which the headless host keeps itself, having
// no shell around it to keep it: the credential and device key in
// userData's account.json, as plaintext in a file only its owner can
// read (main/electron/account.ts says why), handed to the host as the
// Electron shell hands them (applyAccount). Signing in is the
// terminal's (`sm login`, the login contract): Clerk's device grant
// (shared/account/deviceGrant.ts), whose access token enrolls this
// device once and is dropped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  isConfigured,
  mergeServiceEnv,
  resolveServiceConfig,
  type AccountServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import { callFailureOf, errorMessageOf } from "@shigomori/contracts/errors";
import {
  loginContract,
  type LoginCode,
  type LoginStatus,
} from "@shigomori/contracts/modules/login";
import type { AccountFacts } from "@shigomori/contracts/modules/session";
import type { EffectHandlers } from "@shigomori/contracts/types";
import { current as currentPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { applyAccount } from "@host/process/handlers";
import type { HostServices } from "@host/process/services";
import { registerLoopbackContract } from "@host/process/wires";
import { createAccountStore } from "@shared/account/credentialFile";
import { defaultDesktopDeviceName } from "@shared/account/defaultDeviceName";
import {
  enrollDevice,
  retryParkedRevoke,
  signOutDevice,
} from "@shared/account/enroll";
import {
  awaitDeviceGrant,
  startDeviceGrant,
} from "@shared/account/deviceGrant";
import { createAccountService } from "@shared/account/service";
import type { HostFacts } from "@shared/hostFacts";
import type { HandlerContext } from "@shared/ipc/transport";
import { log } from "@shared/log";

// Lowest to highest, as the desktop's (main/electron/account.ts): a dev
// run's .env.local in the checkout it runs from, the values baked into
// the bundle, the real environment. A packaged host reads no file.
function serviceConfig(facts: HostFacts): AccountServiceConfig {
  let fileEnv: Record<string, string | undefined> = {};
  if (!facts.packaged) {
    try {
      fileEnv = parseEnv(
        readFileSync(join(process.cwd(), ".env.local"), "utf8"),
      );
    } catch {
      // No dev file. Baked and environment values are the only sources.
    }
  }
  return resolveServiceConfig(
    mergeServiceEnv(fileEnv, __SM_ACCOUNT_BAKED_ENV__, process.env),
  );
}

const call = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: callFailureOf });

export type HeadlessAccount = ReturnType<typeof headlessAccount>;

// Made before the host starts, since the loopback takes its contracts
// as it starts. The device id comes once the host is up (boot), and a
// call before then waits for it.
export function headlessAccount(facts: HostFacts) {
  const config = serviceConfig(facts);
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
  // The account's changes, one at a time and each whole, the host told
  // of it included.
  const transitions = Semaphore.makeUnsafe(1);
  const inTurn = (change: () => Promise<void>) =>
    Effect.runPromise(
      transitions.withPermit(
        Effect.promise(async () => {
          await change();
          await applyAccount(factsForHost());
        }),
      ),
    );

  function factsForHost(): AccountFacts | null {
    const record = store.read();
    if (record === null || !isConfigured(config)) return null;
    return {
      hubUrl: config.hubUrl,
      accountId: record.accountId,
      credential: record.credential,
      deviceKey: record.deviceKey,
      webOrigin: config.webOrigin,
      acceptsCommands: record.acceptsCommands === true,
    };
  }

  const status = async (): Promise<LoginStatus> => {
    const record = store.read();
    return {
      signedIn: record !== null,
      deviceName:
        record?.deviceName ??
        store.rememberedDeviceName() ??
        (await defaultDesktopDeviceName()).name,
    };
  };

  const start = async (signal: AbortSignal): Promise<LoginCode> => {
    const record = store.read();
    if (record !== null) {
      throw new Error(
        `This machine is signed in already, as ${record.deviceName}. Sign out first.`,
      );
    }
    return startDeviceGrant(config, signal);
  };

  // Enrolls under the access token once the person approved.
  const finish = async (
    code: LoginCode,
    signal: AbortSignal,
  ): Promise<LoginStatus> => {
    await signIn(await awaitDeviceGrant(config, code, signal));
    return status();
  };

  const signIn = async (token: string) => {
    const name = await defaultDesktopDeviceName();
    const deviceId = await deviceIdOf;
    await inTurn(() =>
      enrollDevice(
        {
          config,
          service,
          store,
          deviceId,
          fallbackDeviceName: name.name,
          platform: currentPlatform(),
          detectedIcon: "server",
        },
        token,
      ),
    );
  };

  // The command switch, kept on the account's record.
  const setAcceptsCommands = (enabled: boolean) =>
    inTurn(async () => {
      const record = store.read();
      if (record === null) throw new Error("This machine isn't signed in.");
      store.write({ ...record, acceptsCommands: enabled });
    });

  // The revoke is best effort: offline, it is parked for the next start
  // (retryParkedRevoke), and this device signs out here anyway. Commands
  // are refused from the first moment, ahead of the revoke's round trip.
  const signOut = async () => {
    const deviceId = await deviceIdOf;
    if (store.read()?.acceptsCommands === true) await setAcceptsCommands(false);
    await inTurn(() =>
      signOutDevice({
        config,
        service,
        store,
        deviceId,
        onRevokeFailure: (error) =>
          log.warn(
            `[account] the hub didn't take this device's revoke, so it's kept for later: ${errorMessageOf(error)}`,
          ),
      }),
    );
  };

  const login: EffectHandlers<
    typeof loginContract,
    HandlerContext,
    HostServices
  > = {
    status: () => call(status),
    start: () => call(start),
    finish: (code) => call((signal) => finish(code, signal)),
    signOut: () => call(signOut),
  };
  registerLoopbackContract(loginContract, login);

  return {
    setAcceptsCommands,
    // The account as this start finds it, and a revoke a sign-out
    // couldn't deliver, delivered now.
    boot: async (deviceId: string) => {
      deviceIdIs(deviceId);
      await applyAccount(factsForHost());
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
    // A nuke's sign-out, as the desktop's (main/electron/account.ts):
    // why the revoke didn't land when it stays parked, else null.
    signOutForNuke: async (): Promise<string | null> => {
      const deviceId = await deviceIdOf;
      let failure = "";
      await inTurn(async () => {
        const signedIn = store.read() !== null;
        await signOutDevice({
          config,
          service,
          store,
          deviceId,
          onRevokeFailure: (error) => {
            failure = errorMessageOf(error);
          },
        });
        if (!signedIn) {
          const parked = await retryParkedRevoke({
            config,
            service,
            store,
            deviceId,
          });
          if (parked.kind === "failed") failure = errorMessageOf(parked.error);
        }
      });
      return store.readParked() === null ? null : failure;
    },
  };
}
