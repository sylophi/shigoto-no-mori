// The two-device boot helper shared by the relay-transport e2e checks
// (check-relay-link.mjs, check-sync-transfer.mjs,
// check-port-forward.mjs): a REAL relay connection against the stub
// Durable Object (relayStub.mjs, extracted for the same reason), plus
// the delay/waitFor polling pair every one of them carries. Runs under
// register-ts-alias so the shared TypeScript imports resolve.
import { createRelayConnection } from "@host/relay/connection";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Boots one device on the stub relay and waits until it connects.
// Returns the connection plus the ticket-mint counter the redial
// assertions read. `opts.registerHandlers`, when set, is a callback
// receiving the connection's ServerTransport half, so each check keeps
// its own handler set. `track`, when passed, registers the teardown
// immediately, so a boot that fails its wait still gets cleaned up and
// cannot leak the event loop.
export async function bootDevice(stub, deviceId, opts = {}, track) {
  let mints = 0;
  const connection = createRelayConnection({
    onChange: opts.onChange,
    onPeerPush: opts.onPeerPush,
    // The grant predicate the host role consults live at dispatch.
    // Tests pass a toggleable one to drive command-grant enforcement.
    isCommandGranted: opts.isCommandGranted,
  });
  if (track) track(() => connection.stop());
  opts.registerHandlers?.(connection.server);
  await connection.refresh(async () => ({
    relayUrl: stub.relayUrl,
    accountId: opts.accountId ?? "acct",
    mintTicket: async () => {
      mints += 1;
      return `t:${deviceId}:${mints}`;
    },
    deviceId,
    appVersion: opts.appVersion ?? "1.0.0",
  }));
  await waitFor(
    () => connection.status().socket.phase === "connected",
    `${deviceId} to connect`,
  );
  return { connection, mints: () => mints };
}
