// The two-device boot helper shared by the relay-transport e2e checks
// (check-relay-link.mjs, check-sync-transfer.mjs,
// check-port-forward.mjs): a REAL relay connection against the stub
// Durable Object (relayStub.mjs, extracted for the same reason), plus
// the delay/waitFor polling pair every one of them carries. Runs under
// register-ts-alias so the shared TypeScript imports resolve.
import { directContract } from "@shared/ipc/modules/direct";
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
// assertions read. The binding's ONE broker slot (the only thing the
// relay wire can serve) takes a channel-plus-handler pair:
// `opts.broker` passes one through verbatim, `opts.brokerHandler`
// wraps a bare handler with the real broker channel. `track`, when
// passed, registers the teardown immediately, so a boot that fails its
// wait still gets cleaned up and cannot leak the event loop.
export async function bootDevice(stub, deviceId, opts = {}, track) {
  let mints = 0;
  const connection = createRelayConnection({
    // The channel is creation-time config (the client role dials it
    // even on devices that never register a handler), matching how
    // main composes the binding.
    brokerChannel: directContract.calls.connectInfo.channel,
    onChange: opts.onChange,
  });
  if (track) track(() => connection.stop());
  const broker =
    opts.broker ??
    (opts.brokerHandler
      ? {
          channel: directContract.calls.connectInfo.channel,
          handler: opts.brokerHandler,
        }
      : undefined);
  if (broker) connection.registerBroker(broker);
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
