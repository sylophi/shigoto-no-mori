// This device on Colibrii (@colibrii/sdk): its enrollment, its hub
// socket and roster, the links it dials and the ones its listener takes
// (DeviceLink.ts), and the tunnel fronting that listener. The host's
// alone: the shells reach it through the session calls
// (process/device.ts).
//
// Its enrollment is a file in userData, sealed with the key the shell
// keeps in the OS keychain where there is one (Shell.deviceStoreKey),
// else readable by its owner alone. Listening follows the
// directConnections setting, and the tunnel runs the configured
// cloudflared, else the one the app carries: the device is made again
// when either changes. The service stays the same across that, and so
// does every stream it gives.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as Colibrii from "@colibrii/sdk";
import * as ColibriiNode from "@colibrii/sdk/node";
import {
  isConfigured,
  type AccountServiceConfig,
} from "@shigomori/contracts/accountServiceConfig";
import * as EngineConfig from "@shigomori/engine/Config";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import { bundledBinaryPath } from "@shared/packaging/bundledBinary.mts";
import {
  CLOUDFLARED_BINARY_NAME,
  CLOUDFLARED_DIST_DIR,
} from "@shared/packaging/cloudflaredDist.mts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as HostFacts from "@host/lib/HostFacts";
import * as Shell from "@host/lib/Shell";
import * as DeviceLink from "@host/socket/DeviceLink";
import { inertDevice } from "@shared/hub/inertDevice";

export class PeerDevice extends Context.Service<PeerDevice, Colibrii.Device>()(
  "sm/host/PeerDevice",
) {}

const STORE_FILE = "colibrii.json";

// AES-GCM under the shell's key. A document it can't open (the key was
// lost with the keychain) reads as none, so the device enrolls again.
const cipherOf = (key: string): ColibriiNode.Cipher => {
  const secret = Buffer.from(key, "base64");
  return {
    encrypt: (text) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt: (data) => {
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          secret,
          data.subarray(0, 12),
        );
        decipher.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([
          decipher.update(data.subarray(28)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        return "";
      }
    },
  };
};

type Settings = {
  readonly listen: boolean;
  readonly cloudflared: string | undefined;
};

export const layer = (config: AccountServiceConfig) =>
  Layer.effect(
    PeerDevice,
    Effect.gen(function* () {
      const facts = yield* HostFacts.HostFacts;
      const link = yield* DeviceLink.DeviceLink;
      const engineConfig = yield* EngineConfig.Config;
      const deviceId = yield* DeviceId.current;
      const shell = yield* Shell.Shell;
      const fs = yield* FileSystem.FileSystem;
      const storePath = (yield* Path.Path).join(facts.userDataPath, STORE_FILE);
      // The key asked for at each make: one that can't be had leaves
      // that device unmade, never on a plain store.
      const services = Layer.mergeAll(
        ColibriiNode.layer,
        Layer.unwrap(
          Effect.map(shell.deviceStoreKey, (key) =>
            key === null
              ? ColibriiNode.layerFileStore(storePath)
              : ColibriiNode.layerEncryptedFileStore(storePath, cipherOf(key)),
          ),
        ),
      );
      const bundled = bundledBinaryPath(
        facts,
        CLOUDFLARED_DIST_DIR,
        CLOUDFLARED_BINARY_NAME,
      );

      const settingsNow = Effect.gen(function* () {
        const device = yield* engineConfig.readDevice;
        const carried = yield* fs
          .exists(bundled)
          .pipe(Effect.orElseSucceed(() => false));
        return {
          listen: device.directConnections !== false,
          cloudflared:
            device.cloudflaredPath ?? (carried ? bundled : undefined),
        } satisfies Settings;
      });

      // One device, until its scope closes.
      const makeDevice = (settings: Settings, scope: Scope.Scope) =>
        Colibrii.make({
          hub: config.hubUrl,
          app: config.app,
          connections: "single",
          deviceId,
          ...(settings.listen
            ? {
                listen: {
                  origins: config.webOrigin === "" ? [] : [config.webOrigin],
                  admit: link.admit,
                  onLink: link.serve,
                },
              }
            : {}),
        }).pipe(
          Effect.provide(
            Layer.merge(
              services,
              ColibriiNode.layerTunnel({
                directory: facts.userDataPath,
                ...(settings.cloudflared === undefined
                  ? {}
                  : { cloudflared: settings.cloudflared }),
              }),
            ),
          ),
          Scope.provide(scope),
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logError("[peers] the device could not start", cause),
              inertDevice(cause),
            ),
          ),
        );

      const current = yield* SubscriptionRef.make<Colibrii.Device | null>(null);
      let made: { settings: Settings; scope: Scope.Closeable } | null = null;
      const remake = (settings: Settings) =>
        Effect.gen(function* () {
          if (
            made !== null &&
            made.settings.listen === settings.listen &&
            made.settings.cloudflared === settings.cloudflared
          ) {
            return;
          }
          if (made !== null) {
            yield* SubscriptionRef.set(current, null);
            yield* Scope.close(made.scope, Exit.void);
          }
          const scope = yield* Scope.make();
          made = { settings, scope };
          yield* SubscriptionRef.set(
            current,
            yield* makeDevice(settings, scope),
          );
        });
      yield* Effect.addFinalizer(() =>
        made === null ? Effect.void : Scope.close(made.scope, Exit.void),
      );

      if (!isConfigured(config)) {
        yield* SubscriptionRef.set(
          current,
          inertDevice(new Error("This build has no account service.")),
        );
      } else {
        yield* Effect.flatMap(settingsNow, remake);
        const written = yield* (yield* StoreChanges.StoreChanges).subscribe;
        yield* written.pipe(
          Stream.filter((tables) => tables.has("device_config")),
          Stream.runForEach(() => Effect.flatMap(settingsNow, remake)),
          Effect.catchCause((cause) =>
            Effect.logWarning("[peers] following the settings failed", cause),
          ),
          Effect.forkScoped,
        );
      }

      // The device now, once there is one.
      const now = SubscriptionRef.changes(current).pipe(
        Stream.filter((device) => device !== null),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      const latest = <A>(of: (device: Colibrii.Device) => Stream.Stream<A>) =>
        SubscriptionRef.changes(current).pipe(
          Stream.filter((device) => device !== null),
          Stream.switchMap(of),
        );
      const on =
        <A extends ReadonlyArray<unknown>, B, E, R>(
          call: (
            device: Colibrii.Device,
          ) => (...args: A) => Effect.Effect<B, E, R>,
        ) =>
        (...args: A) =>
          Effect.flatMap(now, (device) => call(device)(...args));

      return PeerDevice.of({
        account: latest((device) => device.account),
        roster: latest((device) => device.roster),
        tunnel: latest((device) => device.tunnel),
        enroll: on((device) => device.enroll),
        signOut: Effect.flatMap(now, (device) => device.signOut),
        devices: {
          list: Effect.flatMap(now, (device) => device.devices.list),
          rename: on((device) => device.devices.rename),
          setData: on((device) => device.devices.setData),
          remove: on((device) => device.devices.remove),
        },
        dial: on((device) => device.dial),
        wake: Effect.flatMap(now, (device) => device.wake),
      });
    }),
  );
