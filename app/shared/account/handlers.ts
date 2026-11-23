// The account calls the shells serve (accountContract): the desktop's
// (main/electron/account.ts), the web bridge's (web/ipc/register.ts)
// and the headless host's (headless/account.ts) give only what differs:
// where their device is, their profile's store, the device's defaults,
// their platform, and what follows a change.
import * as Colibrii from "@colibrii/sdk";
import type { AccountServiceConfig } from "@shigomori/contracts/accountServiceConfig";
import { isConfigured } from "@shigomori/contracts/accountServiceConfig";
import { RemoteCallError } from "@shigomori/contracts/errors";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import type {
  AccountStatus,
  accountContract,
} from "@shigomori/contracts/modules/account";
import type { LoginCode } from "@shigomori/contracts/modules/login";
import type {
  DeviceAccount,
  DeviceData,
} from "@shigomori/contracts/modules/session";
import type { Handlers } from "@shigomori/contracts/types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Predicate from "effect/Predicate";
import { joinInFlight } from "@shared/inFlight";
import type { Profile, ProfileStore } from "./profile";

// The device's account calls, wherever the device runs: the host's
// (over the session calls, or in the headless shell's own process), or
// the web client's tab.
export type DevicePort = {
  readonly account: () => Promise<DeviceAccount>;
  readonly enroll: (input: {
    readonly loginToken: string;
    readonly name: string;
    readonly data: DeviceData;
  }) => Promise<void>;
  // Whether the service has let the device go, so nothing is owed.
  readonly signOut: () => Promise<boolean>;
  readonly listDevices: () => Promise<readonly DeviceInfo[]>;
  readonly renameDevice: (input: {
    readonly deviceId: string;
    readonly name: string;
  }) => Promise<void>;
  readonly setDeviceData: (input: {
    readonly deviceId: string;
    readonly data: DeviceData;
  }) => Promise<void>;
  readonly removeDevice: (deviceId: string) => Promise<void>;
};

export type AccountShell = {
  readonly config: () => AccountServiceConfig;
  readonly device: DevicePort;
  readonly profile: () => ProfileStore;
  readonly deviceId: () => Promise<string>;
  // The name a device that never enrolled goes by. A provisional one
  // (the system didn't say in time) is asked for again before an enroll
  // keeps it.
  readonly defaultName: () => Promise<{
    readonly name: string;
    readonly provisional: boolean;
  }>;
  readonly detectedIcon: () => Promise<DeviceIcon>;
  // What sm keeps on the device's record beside its icon.
  readonly platform: string;
  // Whether this device signed in by copying another's sign-in.
  readonly sharedSignIn: () => boolean;
  // Whether a window signs in with a code (account:startCodeSignIn).
  readonly codeSignIn: boolean;
  // This device's name or icon, or the account's devices, changed here,
  // its account the same.
  readonly changed: () => Promise<void> | void;
  // The account the command switch is on for (null: off), at every
  // flip.
  readonly acceptsCommandsChanged: (
    accountId: string | null,
  ) => Promise<void> | void;
};

// The account an account state is of, null signed out.
export const accountIdOf = (state: DeviceAccount): string | null =>
  Predicate.isTagged(state, "SignedOut") ? null : state.accountId;

// The switch for the account signed in now.
export const switchFor = (
  profile: Profile,
  state: DeviceAccount,
): string | null => {
  const accountId = accountIdOf(state);
  return accountId !== null && profile.acceptsCommandsFor === accountId
    ? accountId
    : null;
};

// Clerk's device grant, which a window and the terminal's `sm login`
// sign in with.
const codeOptionsOf = (
  config: AccountServiceConfig,
): Effect.Effect<Colibrii.CodeSignInOptions, RemoteCallError> =>
  config.oauthClientId === ""
    ? Effect.fail(
        new RemoteCallError({
          text: "This build has no OAuth client to sign in with a code.",
        }),
      )
    : Effect.succeed({
        publishableKey: config.publishableKey,
        clientId: config.oauthClientId,
      });

export const startCodeSignIn = (config: AccountServiceConfig) =>
  codeOptionsOf(config).pipe(
    Effect.flatMap(Colibrii.startCodeSignIn),
    Effect.map(({ verificationUriComplete, ...code }): LoginCode =>
      verificationUriComplete === undefined
        ? code
        : { ...code, verificationUriComplete },
    ),
    Effect.provide(FetchHttpClient.layer),
  );

// The access token Clerk gives once the person approved the code.
export const accessTokenFor = (config: AccountServiceConfig, code: LoginCode) =>
  codeOptionsOf(config).pipe(
    Effect.flatMap((options) =>
      Colibrii.finishCodeSignIn(options, {
        ...code,
        verificationUriComplete: code.verificationUriComplete,
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

// The session token an enroll was asked with, which the run reads.
class EnrollToken extends Context.Service<EnrollToken, string>()(
  "sm/account/EnrollToken",
) {}

export function makeAccountHandlers(
  shell: AccountShell,
): Handlers<typeof accountContract> {
  // The listing last answered, kept for the shell's life with the
  // account it was for (lastListedDevices).
  let lastListed: {
    readonly accountId: string;
    readonly devices: readonly DeviceInfo[];
  } | null = null;

  const iconOf = async (profile: Profile) =>
    profile.deviceIcon ?? (await shell.detectedIcon());
  const nameOf = async (profile: Profile) =>
    profile.deviceName ?? (await shell.defaultName()).name;

  const status = async (): Promise<AccountStatus> => {
    const state = await shell.device.account();
    const profile = shell.profile().read();
    return {
      configured: isConfigured(shell.config()),
      signedIn: accountIdOf(state) !== null,
      accountId: accountIdOf(state) ?? "",
      deviceName: await nameOf(profile),
      deviceIcon: await iconOf(profile),
      detectedDeviceIcon: await shell.detectedIcon(),
      sharedSignIn: shell.sharedSignIn(),
      codeSignIn: shell.codeSignIn,
    };
  };

  const signedInAs = async () => {
    const accountId = accountIdOf(await shell.device.account());
    if (accountId === null) {
      throw new Error("cannot change a device while signed out");
    }
    return accountId;
  };

  // A change to this device's name or icon, kept here too, so the next
  // enrollment wears it.
  const keep = async (change: {
    readonly deviceName?: string;
    readonly deviceIcon?: DeviceIcon | undefined;
  }) => {
    const { deviceIcon, ...rest } = { ...shell.profile().read(), ...change };
    shell
      .profile()
      .write(deviceIcon === undefined ? rest : { ...rest, deviceIcon });
    await shell.changed();
  };

  // The icon kept as a pick, or none when it is what the device detects.
  const pickOf = async (icon: DeviceIcon) =>
    icon === (await shell.detectedIcon()) ? undefined : icon;

  const enroll = async (token: string): Promise<AccountStatus> => {
    const profile = shell.profile().read();
    let name = profile.deviceName;
    if (name === undefined) {
      let fallback = await shell.defaultName();
      if (fallback.provisional) fallback = await shell.defaultName();
      name = fallback.name;
    }
    await shell.device.enroll({
      loginToken: token,
      name,
      data: { platform: shell.platform, icon: await iconOf(profile) },
    });
    if (profile.deviceName === undefined) {
      shell.profile().write({ ...shell.profile().read(), deviceName: name });
    }
    return status();
  };

  // Commands are refused from the first moment, ahead of the sign-out.
  const signOut = async (): Promise<void> => {
    const store = shell.profile();
    const { acceptsCommandsFor: _, ...rest } = store.read();
    store.write(rest);
    await shell.acceptsCommandsChanged(null);
    await shell.device.signOut();
  };

  // A concurrent enroll (a re-fired renderer effect, two windows) rides
  // the one under way, its own token unused.
  const enrollOnce = joinInFlight(
    Effect.flatMap(EnrollToken, (token) => Effect.promise(() => enroll(token))),
  );
  const signOutOnce = joinInFlight(Effect.promise(signOut));

  return {
    status,
    enroll: (token) =>
      Effect.runPromise(Effect.provideService(enrollOnce, EnrollToken, token)),
    signOut: () => Effect.runPromise(signOutOnce),

    startCodeSignIn: () => Effect.runPromise(startCodeSignIn(shell.config())),
    finishCodeSignIn: (code) => {
      const config = shell.config();
      return Effect.runPromise(
        accessTokenFor(config, code).pipe(
          Effect.flatMap((accessToken) =>
            Colibrii.signInToken({
              hub: config.hubUrl,
              app: config.app,
              accessToken,
            }),
          ),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
    },

    // Removing this device reads as removed, which signs it out. One
    // that is offline changes no roster, so the windows hear it here.
    revokeDevice: async (deviceId) => {
      await shell.device.removeDevice(deviceId);
      await shell.changed();
    },

    listDevices: async () => {
      const state = await shell.device.account();
      const accountId = accountIdOf(state);
      if (accountId === null) return [];
      const askedWith = shell.profile().read();
      const devices = await shell.device.listDevices();
      lastListed = { accountId, devices };
      // A peer's change to this device's name or icon, taken from the
      // listing, unless one made here while it was asked for is newer.
      const self = await shell.deviceId();
      const listed = devices.find((device) => device.deviceId === self);
      const profile = shell.profile().read();
      if (
        listed !== undefined &&
        profile.deviceName === askedWith.deviceName &&
        profile.deviceIcon === askedWith.deviceIcon &&
        (listed.name !== (await nameOf(profile)) ||
          listed.icon !== (await iconOf(profile)))
      ) {
        await keep({
          deviceName: listed.name,
          deviceIcon: await pickOf(listed.icon),
        });
      }
      return [...devices];
    },

    lastListedDevices: async () => {
      const accountId = accountIdOf(await shell.device.account());
      return lastListed !== null && lastListed.accountId === accountId
        ? [...lastListed.devices]
        : [];
    },

    setDeviceName: async ({ deviceId, name }) => {
      await signedInAs();
      await shell.device.renameDevice({ deviceId, name });
      if (deviceId === (await shell.deviceId())) {
        await keep({ deviceName: name });
      }
      return status();
    },

    // The whole of sm's data goes with it: the platform beside it is
    // the device's own, or the one its listing said.
    setDeviceIcon: async ({ deviceId, icon }) => {
      await signedInAs();
      const self = deviceId === (await shell.deviceId());
      const platform = self
        ? shell.platform
        : (lastListed?.devices.find((device) => device.deviceId === deviceId)
            ?.platform ?? "");
      await shell.device.setDeviceData({
        deviceId,
        data: { platform, icon },
      });
      if (self) await keep({ deviceIcon: await pickOf(icon) });
      return status();
    },

    acceptsCommands: async () =>
      switchFor(shell.profile().read(), await shell.device.account()) !== null,
    setAcceptsCommands: async (enabled) => {
      const accountId = await signedInAs().catch(() => {
        throw new Error("cannot change command access while signed out");
      });
      const store = shell.profile();
      const { acceptsCommandsFor: _, ...rest } = store.read();
      store.write(enabled ? { ...rest, acceptsCommandsFor: accountId } : rest);
      await shell.acceptsCommandsChanged(enabled ? accountId : null);
    },
  };
}
