// The two-device boot under directBoot.mts: a REAL hub connection
// against the stub Durable Object (hubStub.mts).
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { HubConnection } from "@shared/hub/connection";
import {
  type HubConnectionOpts,
  make as makeHubConnection,
} from "@host/hub/connection";

import { type Track, waitFor } from "./checkKit.mts";
import { type StubHub, testDeviceKey } from "./hubStub.mts";

export type BootDeviceOpts = HubConnectionOpts & {
  createConnection?: (
    opts: HubConnectionOpts,
  ) => Effect.Effect<HubConnection, never, Scope.Scope>;
  accountId?: string;
  label?: string;
  // What the stub hub admits the device as: a desktop (the default)
  // holds one socket, a web device one per connection.
  kind?: "desktop" | "web";
};

export type BootedDevice = {
  connection: HubConnection;
  mints(): number;
  // Closes the connection's scope, as its owner's teardown does.
  stop(): Promise<void>;
};

// Boots one device on the stub device hub and waits until it connects.
// Returns the connection plus the ticket-mint counter the redial
// assertions read. `opts.serveConnectInfo` is the one thing the hub
// wire can answer (absent: a dial-only device that refuses every ask
// as serving no listener). `track`, when passed, registers the teardown immediately, so a boot that fails its
// wait still gets cleaned up and cannot leak the event loop.
// `opts.createConnection` swaps in another binding with the same
// surface (the browser one, web/hub/connection.ts), and `opts.label`
// names the device in the connect wait's timeout message.
export async function bootDevice(
  stub: Pick<StubHub, "hubUrl">,
  deviceId: string,
  opts: BootDeviceOpts = {},
  track?: Track,
): Promise<BootedDevice> {
  let mints = 0;
  const createConnection = opts.createConnection ?? makeHubConnection;
  const scope = Scope.makeUnsafe();
  const stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const connection = Effect.runSync(
    createConnection({
      serveConnectInfo: opts.serveConnectInfo,
      onChange: opts.onChange,
      // The ping seams, so the liveness scenario runs in milliseconds
      // instead of the shared production cadence.
      ping: opts.ping,
    }).pipe(Scope.provide(scope)),
  );
  if (track) track(stop);
  await Effect.runPromise(
    connection.refresh(
      Effect.succeed({
        hubUrl: stub.hubUrl,
        accountId: opts.accountId ?? "acct",
        mintTicket: async (connectionId: string) => {
          mints += 1;
          return `t:${deviceId}:${opts.kind ?? "desktop"}:${connectionId}`;
        },
        deviceId,
        deviceKey: testDeviceKey(deviceId).privateKey,
      }),
    ),
  );
  await waitFor(
    () => connection.status().socket.phase === "connected",
    `${opts.label ?? deviceId} to connect`,
  );
  return { connection, mints: () => mints, stop };
}
