// Durable proof for Settings' "Restart to update" pressed in this
// machine's own window: the call the button makes
// (renderer/lib/updates.ts restartIntoUpdate, over the window's link,
// shared/remote/hostLink.ts) to the REAL updater:install handler
// (host/ipc/modules/updater.ts) on the REAL loopback
// (host/socket/Loopback.ts), with the shell's side (main/electron/
// updater.ts, which needs Electron) stood in for. Asserts:
//   - the window's call reaches the shell as an attended install (no
//     calling device), and its answer is the button's success.
//   - the host going away under the call, as the app's quit takes it
//     down, fails the bare call as this device's link dropping, in
//     those words and not a remote device's, and the button reads that
//     as the restart under way rather than a failure.
//   - the shell's own failure (the installer that couldn't start)
//     reaches the button in its words, for the toast.
//
// Run: pnpm test restart-to-update.
import { LOOPBACK_FILE } from "@shigomori/engine/Control";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CallFailure,
  callFailureOf,
  errorMessageOf,
} from "@shigomori/contracts/errors";
import { updaterContract } from "@shigomori/contracts/modules/updater";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterAll, it } from "vitest";
import { WebSocket as WsWebSocket } from "ws";
import { updaterHandlers } from "@host/ipc/modules/updater";
import * as Shell from "@host/lib/Shell";
import * as Views from "@host/lib/Views";
import type { LinkRegistrar } from "@host/socket/DeviceLink";
import * as Loopback from "@host/socket/Loopback";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import { effectClient } from "@shared/ipc/effectClient";
import { createServed } from "@shared/ipc/served";
import { hostLink } from "@shared/remote/hostLink";
import { RemoteDisconnectedError } from "@shared/remote/rpcTransport";
import { restartIntoUpdate } from "@/lib/updates";
import { hostContext } from "./lib/hostRuntime.mts";
import { pushesLayer } from "./lib/hostStandIns.mts";

const dataDirs: string[] = [];
afterAll(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

// The REAL loopback serving updater:install, its shell's install the
// given one, which it hands whether the call came from another device.
async function startHost(
  install: (stop: () => void) => Effect.Effect<void, CallFailure>,
) {
  const dataDir = mkdtempSync(join(tmpdir(), "restart-to-update-"));
  dataDirs.push(dataDir);
  const asked: boolean[] = [];
  const scope = Scope.makeUnsafe();
  const stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const shell = Shell.Shell.of({
    relaunch: Effect.void,
    moveFailed: () => Effect.void,
    updater: {
      check: Effect.void,
      install: (unattended) =>
        Effect.suspend(() => {
          asked.push(unattended);
          return install(() => void stop());
        }),
      update: () => Effect.void,
      state: Effect.succeed({ kind: "idle" }),
      noteState: () => Effect.void,
    },
    holdUpdater: () => Effect.succeed(null),
    resumeUpdater: Effect.void,
    stopUpdaterBridge: Effect.void,
    migration: () => Effect.void,
    guide: () => Effect.die("no guide here"),
  });
  const registrar: LinkRegistrar = createServed();
  registrar.serveOne(updaterContract, "install", updaterHandlers.install);
  const host = Context.add(await hostContext(), Shell.Shell, shell);
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      Loopback.layer({
        registrar,
        deviceId: () => "this-device",
        appVersion: "9.9.9",
        file: () => join(dataDir, LOOPBACK_FILE),
        services: Effect.succeed(host),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(StoreChanges.layer, pushesLayer, Views.layer).pipe(
            Layer.provideMerge(Layer.succeedContext(host)),
          ),
        ),
      ),
      scope,
    ) as Effect.Effect<Context.Context<Loopback.Loopback>, never, never>,
  );
  const { port, token } = await Effect.runPromise(
    Context.get(context, Loopback.Loopback).address,
  );
  return { address: { port, token, deviceId: "this-device" }, asked, stop };
}

// The window's api for its own device: the updater over its link to the
// host, run as the renderer's runner runs it (Api.ts).
async function windowOn(host: Awaited<ReturnType<typeof startHost>>) {
  const scope = Scope.makeUnsafe();
  const api = await Effect.runPromise(
    Effect.gen(function* () {
      const link = yield* hostLink({
        address: Effect.succeed(host.address),
        appVersion: "9.9.9",
        openSocket: (url) => new WsWebSocket(url),
      });
      const run = yield* FiberSet.makeRuntimePromise<never>();
      return { updater: effectClient(updaterContract, link), run };
    }).pipe(Scope.provide(scope)),
  );
  return {
    api,
    [Symbol.asyncDispose]: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await host.stop();
    },
  };
}

it("the window's press is an attended install, and its answer the button's success", async () => {
  const host = await startHost(() => Effect.void);
  await using window = await windowOn(host);
  await restartIntoUpdate(window.api);
  assert.deepEqual(host.asked, [false]);
});

// The app's quit, taking the host down before the install answered.
const quitting = (stop: () => void) =>
  Effect.sync(stop).pipe(Effect.andThen(Effect.never));

it("the host going away under the press is the restart under way, said as this device's drop", async () => {
  const bare = await startHost(quitting);
  await using first = await windowOn(bare);
  const dropped = await first.api.run(first.api.updater.install()).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(dropped instanceof RemoteDisconnectedError);
  assert.equal(dropped.local, true);
  assert.equal(
    errorMessageOf(dropped),
    "lost the connection to the app's background process",
  );

  const pressed = await startHost(quitting);
  await using second = await windowOn(pressed);
  await restartIntoUpdate(second.api);
  assert.deepEqual(pressed.asked, [false]);
});

it("the shell's own failure reaches the button in its words", async () => {
  const host = await startHost(() =>
    Effect.fail(callFailureOf(new Error("spawn EACCES"))),
  );
  await using window = await windowOn(host);
  const failed = await restartIntoUpdate(window.api).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failed !== undefined);
  assert.match(errorMessageOf(failed), /spawn EACCES/);
});
