// The services the host's root provides from its own wiring
// (host/process/handlers.ts rootServices, host/process/host.ts), stood
// in for the proofs: no shell, no peers, a mirror engine with nothing
// behind it, a signed-out account, and the device the store names. Each
// answers through what a proof last stood in, so a proof swaps a peer
// or the engine between its checks.
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AccountPeers from "../../host/lib/control/AccountPeers.ts";
import * as DeviceId from "../../host/lib/config/DeviceId.ts";
import { DataDirHolders } from "../../host/lib/DataDirHolders.ts";
import * as HostFacts from "../../host/lib/HostFacts.ts";
import * as HostPushes from "../../host/lib/HostPushes.ts";
import * as Ops from "../../host/lib/engineOps.ts";
import * as Shell from "../../host/lib/Shell.ts";
import * as PeerReach from "../../host/ipc/PeerReach.ts";
import { MirrorEngine } from "../../host/mirror/MirrorEngine.ts";
import { MirrorSignals } from "../../host/mirror/MirrorSignals.ts";
import * as PortForwards from "../../host/portForward/PortForwards.ts";
import { inertMirrorImpl } from "./mirrorFakes.mts";

const notHere = () => Promise.reject(new Error("not in this check"));

let peers = PeerReach.make({
  transportFor: () => ({ invoke: notHere, subscribe: () => () => {} }),
  channelsFor: () => notHere,
});
// The peers a proof reaches, over its own transport.
export const standInPeers = (
  reach: Parameters<typeof PeerReach.make>[0],
): void => {
  peers = PeerReach.make(reach);
};

let mirror = inertMirrorImpl();
export const standInMirror = (engine: MirrorEngine["Service"]): void => {
  mirror = engine;
};

let account = AccountPeers.AccountPeers.of({
  listDevices: Effect.succeed([]),
  directPeers: Effect.succeed({}),
});
export const standInAccount = (
  next: AccountPeers.AccountPeers["Service"],
): void => {
  account = next;
};

let deviceId: string | undefined;
// This device as a proof names it (the direct sandbox's DIALER), in
// place of the id the store minted.
export const standInDeviceId = (id: string): void => {
  deviceId = id;
};

const standIns = Layer.mergeAll(
  Layer.succeed(
    PeerReach.PeerReach,
    PeerReach.PeerReach.of({
      calls: (contract, id) => peers.calls(contract, id),
      onPush: (contract, key, id, handler) =>
        peers.onPush(contract, key, id, handler),
      channels: (id) => peers.channels(id),
    }),
  ),
  Layer.succeed(
    MirrorEngine,
    MirrorEngine.of({
      status: Effect.suspend(() => mirror.status),
      failure: Effect.suspend(() => mirror.failure),
      sessions: Effect.suspend(() => mirror.sessions),
      create: (input) => mirror.create(input),
      recreate: (session, input) => mirror.recreate(session, input),
      terminate: (session) => mirror.terminate(session),
      pause: (session) => mirror.pause(session),
      resume: (session) => mirror.resume(session),
      gitStatus: (session) => mirror.gitStatus(session),
      refreshGit: (session) => mirror.refreshGit(session),
      history: (id) => mirror.history(id),
      noteEvent: (id, kind, detail) => mirror.noteEvent(id, kind, detail),
      forgetHistory: (id) => mirror.forgetHistory(id),
      moveHistory: (from, to) => mirror.moveHistory(from, to),
    }),
  ),
  Layer.succeed(
    AccountPeers.AccountPeers,
    AccountPeers.AccountPeers.of({
      listDevices: Effect.suspend(() => account.listDevices),
      directPeers: Effect.suspend(() => account.directPeers),
    }),
  ),
  Layer.effect(
    DeviceId.DeviceId,
    Effect.map(Ops.deviceId, (stored) =>
      DeviceId.DeviceId.of({
        get id() {
          return deviceId ?? stored;
        },
      }),
    ),
  ),
  Layer.succeed(
    HostFacts.HostFacts,
    HostFacts.HostFacts.of({
      packaged: false,
      appPath: join(import.meta.dirname, "..", ".."),
      resourcesPath: "",
      appVersion: "0.0.0",
      userDataPath: "",
      logsPath: "",
      rendererOrigin: "",
      flavor: "dev",
    }),
  ),
  Layer.succeed(
    Shell.Shell,
    Shell.Shell.of({
      relaunch: Effect.void,
      moveFailed: () => Effect.void,
      updater: {
        check: Effect.void,
        install: () => Effect.void,
        update: () => Effect.void,
        state: Effect.succeed({ kind: "idle" }),
        noteState: () => Effect.void,
      },
      stopUpdaterBridge: Effect.void,
      migration: () => Effect.void,
      guide: () => Effect.die(new Error("not in this check")),
    }),
  ),
  Layer.succeed(DataDirHolders, DataDirHolders.of({ release: Effect.void })),
  // Nothing the serving side tells reaches a window here.
  Layer.succeed(
    MirrorSignals,
    MirrorSignals.of({
      servingChanged: () => {},
      gitChanged: () => {},
      gitApplied: () => {},
    }),
  ),
);

// The forwards are the real engine's, over the stood-in peers.
export const layer = PortForwards.layer({ onChange: () => {} }).pipe(
  Layer.provideMerge(standIns),
);

let pushListener: (push: HostPushes.Push) => void = () => {};
// Every push the proofs' host services make, seen as it is published.
export const onHostPush = (listener: (push: HostPushes.Push) => void): void => {
  pushListener = listener;
};

// The host's pushes, as HostPushes.layer, told to onHostPush first.
export const pushesLayer = Layer.effect(
  HostPushes.HostPushes,
  Effect.map(HostPushes.HostPushes, (pushes) =>
    HostPushes.HostPushes.of({
      ...pushes,
      publish: (push) =>
        Effect.sync(() => pushListener(push)).pipe(
          Effect.andThen(pushes.publish(push)),
        ),
    }),
  ),
).pipe(Layer.provide(HostPushes.layer));
