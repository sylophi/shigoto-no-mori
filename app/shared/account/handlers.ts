// The account calls both shells serve (accountContract): the desktop's
// (main/ipc/modules/account.ts) and the web bridge's
// (web/ipc/register.ts) give only what differs, their store, the
// device's id and defaults, their platform, and what follows a change.
import type { AccountServiceConfig } from "@shigomori/contracts/accountServiceConfig";
import { isConfigured } from "@shigomori/contracts/accountServiceConfig";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import type {
  AccountStatus,
  accountContract,
} from "@shigomori/contracts/modules/account";
import type { Handlers } from "@shigomori/contracts/types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { joinInFlight } from "@shared/inFlight";
import type { AccountStore, StoredAccount } from "./credentialStore";
import {
  type DeviceFields,
  effectiveDeviceIcon,
  enrollDevice,
  signOutDevice,
  syncHubDevice,
  updateDevice,
} from "./enroll";
import type { AccountService } from "./service";

export type AccountShell = {
  readonly config: () => AccountServiceConfig;
  readonly store: () => AccountStore;
  readonly service: (config: AccountServiceConfig) => AccountService;
  readonly deviceId: () => Promise<string>;
  // The name a device that never enrolled goes by. A provisional one
  // (the system didn't say in time) is asked for again before an enroll
  // keeps it.
  readonly defaultName: () => Promise<{
    readonly name: string;
    readonly provisional: boolean;
  }>;
  readonly detectedIcon: () => Promise<DeviceIcon>;
  // The opaque label the hub stores beside the device.
  readonly platform: string;
  // Whether this device signed in by copying another's sign-in.
  readonly sharedSignIn: () => boolean;
  // The account changed, under the ids before and after it (a rename
  // keeps the id). Awaited before the call answers.
  readonly changed: (change: {
    readonly before: string | null;
    readonly after: string | null;
  }) => Promise<void> | void;
  // The registry as the hub last listed it.
  readonly devicesListed: (devices: DeviceInfo[]) => void;
  // Whether peers' commands are taken here, and its switch.
  readonly acceptsCommands: () => boolean;
  readonly setAcceptsCommands: (enabled: boolean) => void;
  // Ahead of a sign-out's revoke (the desktop's switch, off at once).
  readonly beforeSignOut?: (record: StoredAccount) => void;
  readonly onRevokeFailure?: (error: unknown) => void;
};

// The session token an enroll was asked with, which the run reads.
class EnrollToken extends Context.Service<EnrollToken, string>()(
  "sm/account/EnrollToken",
) {}

export function makeAccountHandlers(
  shell: AccountShell,
): Handlers<typeof accountContract> {
  const accountIdOf = () => shell.store().read()?.accountId ?? null;

  const status = async (): Promise<AccountStatus> => {
    const store = shell.store();
    const record = store.read();
    const detectedIcon = await shell.detectedIcon();
    return {
      configured: isConfigured(shell.config()),
      signedIn: record !== null,
      accountId: record?.accountId ?? "",
      // Signed out, the name the device last enrolled under, which is
      // what the next enrollment uses (enroll.ts).
      deviceName:
        record?.deviceName ??
        store.rememberedDeviceName() ??
        (await shell.defaultName()).name,
      // The icon by the same rule (a pick outlives a sign-out too).
      deviceIcon: effectiveDeviceIcon(record, store, detectedIcon),
      detectedDeviceIcon: detectedIcon,
      sharedSignIn: shell.sharedSignIn(),
      needsDeviceKey: store.readWithoutKey() !== null,
    };
  };

  // Runs a change to the account and tells the shell, under the account
  // it was before.
  const changing = async <A>(change: () => Promise<A>): Promise<A> => {
    const before = accountIdOf();
    const result = await change();
    await shell.changed({ before, after: accountIdOf() });
    return result;
  };

  // The calls a signed-in device makes on its account's behalf.
  const signedIn = () => {
    const config = shell.config();
    const record = shell.store().read();
    return record === null || !isConfigured(config)
      ? null
      : { service: shell.service(config), record };
  };

  // A device's name or icon change, made on the hub (updateDevice).
  const update = async (
    deviceId: string,
    patch: DeviceFields,
  ): Promise<AccountStatus> => {
    const account = signedIn();
    if (account === null) {
      throw new Error("cannot change a device while signed out");
    }
    const device = {
      service: account.service,
      store: shell.store(),
      deviceId: await shell.deviceId(),
      detectedIcon: await shell.detectedIcon(),
    };
    await changing(() => updateDevice(device, account.record, deviceId, patch));
    return status();
  };

  const enroll = async (token: string): Promise<AccountStatus> => {
    const config = shell.config();
    let fallback = await shell.defaultName();
    if (fallback.provisional) fallback = await shell.defaultName();
    const device = {
      config,
      service: shell.service(config),
      store: shell.store(),
      // The hub device identity is tied to the data dir's store: a fresh
      // store enrolls as a new hub device.
      deviceId: await shell.deviceId(),
      fallbackDeviceName: fallback.name,
      platform: shell.platform,
      detectedIcon: await shell.detectedIcon(),
    };
    await changing(() => enrollDevice(device, token));
    return status();
  };

  const signOut = async (): Promise<void> => {
    const record = shell.store().read();
    if (record !== null) shell.beforeSignOut?.(record);
    const config = shell.config();
    const device = {
      config,
      service: shell.service(config),
      store: shell.store(),
      deviceId: await shell.deviceId(),
      ...(shell.onRevokeFailure === undefined
        ? {}
        : { onRevokeFailure: shell.onRevokeFailure }),
    };
    await changing(() => signOutDevice(device));
  };

  // A concurrent enroll (a re-fired renderer effect, two windows) must
  // not enroll twice and rotate the credential mid-write, and concurrent
  // sign-outs must not race two revokes, where the second would 401
  // against the credential the first already deleted. A caller arriving
  // while one runs rides it (an enroll's own token unused).
  const enrollOnce = joinInFlight(
    Effect.flatMap(EnrollToken, (token) => Effect.promise(() => enroll(token))),
  );
  const signOutOnce = joinInFlight(Effect.promise(signOut));

  return {
    status,
    enroll: (token) =>
      Effect.runPromise(Effect.provideService(enrollOnce, EnrollToken, token)),
    signOut: () => Effect.runPromise(signOutOnce),

    revokeDevice: async (deviceId) => {
      const account = signedIn();
      if (account === null) {
        throw new Error("cannot revoke a device while signed out");
      }
      // Not swallowed the way sign-out's best-effort revoke is: a failed
      // call leaves the device enrolled, which the caller must say.
      await account.service.revoke(account.record.credential, deviceId);
      const self = deviceId === (await shell.deviceId());
      // A self-revoke killed this device's own credential: dropped now
      // rather than at the hub's next refusal.
      await changing(async () => {
        if (self) shell.store().clear();
      });
    },

    listDevices: async () => {
      const account = signedIn();
      if (account === null) return [];
      const devices = await account.service.listDevices(
        account.record.credential,
      );
      const device = {
        service: account.service,
        store: shell.store(),
        deviceId: await shell.deviceId(),
        detectedIcon: await shell.detectedIcon(),
      };
      // A peer's rename of this device, taken from the listing.
      if (syncHubDevice(device, account.record, devices)) {
        const accountId = account.record.accountId;
        await shell.changed({ before: accountId, after: accountId });
      }
      shell.devicesListed(devices);
      return devices;
    },

    setDeviceName: ({ deviceId, name }) => update(deviceId, { name }),
    setDeviceIcon: ({ deviceId, icon }) => update(deviceId, { icon }),

    acceptsCommands: () => shell.acceptsCommands(),
    setAcceptsCommands: (enabled) => shell.setAcceptsCommands(enabled),
  };
}
