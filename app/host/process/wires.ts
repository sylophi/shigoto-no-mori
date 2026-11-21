// The wires the host serves on. Its Colibrii device (PeerDevice.ts) is
// for peers: the links it dials, and the ones its listener takes, which
// DeviceLink.ts serves. The loopback (host/socket/Loopback.ts) is for
// this machine's windows, its shell and its terminal. The handlers they
// serve are layer.ts's to give them (handlers.ts).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as Terrier from "@shigomori/engine/Terrier";
import * as HostPushes from "@host/lib/HostPushes";
import * as Graph from "./graph";
import { join } from "node:path";
import { LOOPBACK_FILE } from "@shigomori/contracts/link";
import { hubContract } from "@shigomori/contracts/modules/hub";
import * as DirectPlane from "@shared/hub/directPlane";
import { serviceConfigOf } from "@shared/account/hostShell";
import { LayerDownError, layerLatch } from "@shared/layerLatch";
import * as DeviceId from "@host/lib/config/DeviceId";
import { dataDir } from "@shared/paths";
import * as PeerReach from "@host/ipc/PeerReach";
import * as PeerDevice from "@host/lib/PeerDevice";
import * as Shell from "@host/lib/Shell";
import * as Loopback from "@host/socket/Loopback";
import * as DeviceLink from "@host/socket/DeviceLink";
import { acceptsPeerCommands } from "./account";
import { hostFacts } from "./facts";
import { noteDeviceAccount } from "./handlers";

// What a peer's link serves (DeviceLink.ts). Its gates serve a peer
// nothing while the sharing switch is off and run every call not
// annotated gated:false only under the command switch
// (acceptsPeerCommands): every peer is a device of this account, so the
// switches are the whole verdict.
export const deviceLinkLayer = DeviceLink.layer({
  isCommandGranted: acceptsPeerCommands,
});

// This device on Colibrii, listening through deviceLinkLayer.
export const peerDeviceLayer = Layer.unwrap(
  Effect.sync(() => PeerDevice.layer(serviceConfigOf(hostFacts().packaged))),
);

// The link server again, on loopback, for the processes on this
// machine: the windows, the shell, and the terminal's control ops.
export const loopbackLayer = Layer.unwrap(
  Effect.map(DeviceId.current, (deviceId) =>
    Loopback.layer({
      deviceId,
      appVersion: hostFacts().appVersion,
      file: () => join(dataDir(), LOOPBACK_FILE),
      // The window's own page dials it, from the renderer scheme.
      allowedOrigin: hostFacts().rendererOrigin,
    }),
  ),
);

// This device's id, for the root's synchronous callbacks, which run
// once the graph is up.
let deviceId: string | undefined;
const deviceIdNow = () =>
  (deviceId ??= Graph.readNow(DeviceId.current, () => {
    throw new Error("The device id was asked before launch read it.");
  }));

// Each peer as it comes to take this device's calls (PeerReach's
// admissions), off the status snapshots.
export const peerAdmissions = Effect.runSync(PeerReach.makeAdmissions);

// The window-facing hub module, which also lends its invokeOnPeer to
// the host's peer reach (handlers.ts).
export const hubHandlers = () => {
  const up = plane.now();
  if (up === undefined) {
    throw new LayerDownError({ name: "The device hub", reason: "is not up" });
  }
  return up.handlers;
};

// The peer plane (shared/hub/directPlane.ts), for the length of the
// graph. Closing it closes the peer sessions.
const plane = layerLatch<DirectPlane.DirectPlane>("The device hub");
export const remotePlanesLayer = Layer.effectDiscard(
  plane.provide(
    Effect.gen(function* () {
      const pushes = yield* HostPushes.HostPushes;
      const device = yield* PeerDevice.PeerDevice;
      return yield* DirectPlane.make({
        device,
        tunnel: device.tunnel,
        localDeviceId: deviceIdNow,
        localAppVersion: () => hostFacts().appVersion,
        broadcastStatus: (status) => {
          peerAdmissions.note(status);
          pushes.publishUnsafe(hubContract, "statusChanged", status);
        },
        broadcastPeerPush: (push) =>
          pushes.publishUnsafe(hubContract, "peerPush", push),
      });
    }),
  ),
);

// The device's place on the account, as it moves: the host's account
// (handlers.ts) and the shell follow it.
export const followDeviceAccount = Layer.effectDiscard(
  Effect.gen(function* () {
    const device = yield* PeerDevice.PeerDevice;
    const shell = yield* Shell.Shell;
    yield* device.account.pipe(
      Stream.runForEach((state) =>
        Effect.promise(() => noteDeviceAccount(state)).pipe(
          Effect.andThen(shell.account(state)),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

// What follows the device's settings wherever they are written, the
// Settings form or `sm config` in a terminal: terrier's readiness,
// re-probed in case its toggle flipped. The device follows its own
// (PeerDevice.ts).
export const followDeviceSettings = Layer.effectDiscard(
  Effect.gen(function* () {
    const written = yield* (yield* StoreChanges.StoreChanges).subscribe;
    const terrier = yield* Terrier.Terrier;
    yield* written.pipe(
      Stream.filter((tables) => tables.has("device_config")),
      Stream.runForEach(() => terrier.invalidate),
      Effect.forkScoped,
    );
  }),
);
