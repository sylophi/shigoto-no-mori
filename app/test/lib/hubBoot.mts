// The two-device boot helper shared by the hub-transport e2e checks
// (hub-link.mts, sync-transfer.mts,
// port-forward.mts): a REAL hub connection against the stub
// Durable Object (hubStub.mts, extracted for the same reason).
import {
  createHubConnection,
  type HubConnectionBinding,
  type HubConnectionOpts,
} from "@host/hub/connection";

import { type Track, waitFor } from "./checkKit.mts";
import { type StubHub, testDeviceKey } from "./hubStub.mts";

export type BootDeviceOpts = HubConnectionOpts & {
  createConnection?: (opts: HubConnectionOpts) => HubConnectionBinding;
  accountId?: string;
  label?: string;
  // What the stub hub admits the device as: a desktop (the default)
  // holds one socket, a web device one per connection.
  kind?: "desktop" | "web";
};

export type BootedDevice = {
  connection: HubConnectionBinding;
  mints(): number;
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
  const createConnection = opts.createConnection ?? createHubConnection;
  const connection = createConnection({
    serveConnectInfo: opts.serveConnectInfo,
    onChange: opts.onChange,
    // The heartbeat seams, so the liveness scenario runs in
    // milliseconds instead of the shared production cadence.
    heartbeat: opts.heartbeat,
  });
  if (track) track(() => connection.stop());
  await connection.refresh(async () => ({
    hubUrl: stub.hubUrl,
    accountId: opts.accountId ?? "acct",
    mintTicket: async (connectionId) => {
      mints += 1;
      return `t:${deviceId}:${opts.kind ?? "desktop"}:${connectionId}`;
    },
    deviceId,
    deviceKey: testDeviceKey(deviceId).privateKey,
  }));
  await waitFor(
    () => connection.status().socket.phase === "connected",
    `${opts.label ?? deviceId} to connect`,
  );
  return { connection, mints: () => mints };
}
