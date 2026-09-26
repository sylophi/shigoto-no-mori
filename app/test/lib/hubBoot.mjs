// The two-device boot helper shared by the hub-transport e2e checks
// (hub-link.mjs, sync-transfer.mjs,
// port-forward.mjs): a REAL hub connection against the stub
// Durable Object (hubStub.mjs, extracted for the same reason). Runs under
// register-ts-alias so the shared TypeScript imports resolve.
import { createHubConnection } from "@host/hub/connection";

import { waitFor } from "./checkKit.mjs";

// Boots one device on the stub device hub and waits until it connects.
// Returns the connection plus the ticket-mint counter the redial
// assertions read. `opts.serveConnectInfo` is the one thing the hub
// wire can answer (absent: a dial-only device that refuses every ask
// as serving no listener). `track`, when passed, registers the teardown immediately, so a boot that fails its
// wait still gets cleaned up and cannot leak the event loop.
// `opts.createConnection` swaps in another binding with the same
// surface (the browser one, web/hub/connection.ts), and `opts.label`
// names the device in the connect wait's timeout message.
export async function bootDevice(stub, deviceId, opts = {}, track) {
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
    mintTicket: async () => {
      mints += 1;
      return `t:${deviceId}:${mints}`;
    },
    deviceId,
  }));
  await waitFor(
    () => connection.status().socket.phase === "connected",
    `${opts.label ?? deviceId} to connect`,
  );
  return { connection, mints: () => mints };
}
