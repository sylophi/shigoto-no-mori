// Shared fixtures for the checks that run a REAL direct data plane
// beside the stub device hub (scripts/lib/hubStub.mjs): a ticket-mode
// ws listener (host/socket/server.ts), the broker slot registration on
// a hub host device, and the REAL shared composition
// (shared/hub/directPlane.ts) a client drives. Extracted from
// check-direct-plane.mjs so check-sync-transfer.mjs and
// check-port-forward.mjs move their transfer scenarios onto a real
// direct connection without a second copy of the plumbing. Runs under
// register-ts-alias so the shared TypeScript imports resolve.
import { brokerHandlerFor, makeDirectHandlers } from "@host/ipc/modules/direct";
import { createWsServerBinding } from "@host/socket/server";
import { createConnectTicketStore } from "@host/direct/tickets";
import { createDirectPlane } from "@shared/hub/directPlane";
import { WebSocket as WsClient } from "ws";
import { startStubHub } from "./hubStub.mjs";
import { bootDevice, waitFor } from "./hubBoot.mjs";

// A REAL ticket-mode listener on an ephemeral loopback port, with its
// ticket store and a toggleable command-access switch (the host-wide
// "accepts commands from its account's devices" answer the real
// binding reads from main). `registerHandlers`, when
// set, mounts the check's contracts or test channels on the binding
// before it starts.
export async function startDirectListener(track, opts = {}) {
  const tickets = createConnectTicketStore(opts.ticketOpts);
  let accepts = false;
  const binding = createWsServerBinding({
    verifyTicket: (ticket, deviceId) => tickets.consume(ticket, deviceId),
    isCommandGranted: () => accepts,
  });
  opts.registerHandlers?.(binding);
  const port = await binding.start({
    port: 0,
    bindAddress: "127.0.0.1",
    // Ticket mode has no static token, the injected verifier is the
    // auth.
    token: "",
    deviceId: opts.deviceId ?? "B",
    appVersion: "2.0.0",
    helloTimeoutMs: 1000,
  });
  track(() => binding.stop());
  return {
    binding,
    tickets,
    setAccepts: (next) => {
      accepts = next;
    },
    port,
    listenerPort: () => {
      const status = binding.status();
      return status.listening ? status.port : null;
    },
  };
}

// Boots the hub pair: B wires the REAL direct broker pair into its
// binding's one slot (the ONLY thing the hub wire serves, with the
// same channel and zod parse wiring main uses), A is the dialing
// client. The two devices are independent, so they boot concurrently.
export async function bootBrokeredPair(stub, track, listener, opts = {}) {
  const [host, client] = await Promise.all([
    bootDevice(
      stub,
      opts.hostDeviceId ?? "B",
      {
        broker: brokerHandlerFor(
          makeDirectHandlers({
            listenerPort: listener.listenerPort,
            mintTickets: (peerDeviceId, count) => {
              const tickets = listener.tickets.mint(peerDeviceId, count);
              // Observation seam for the mint-alignment assertions.
              if (tickets !== null) opts.onMinted?.(tickets);
              return tickets;
            },
            isPeerOnline: () => true,
            // Deterministic candidates: the listener binds loopback,
            // so real interface enumeration would offer unreachable
            // LAN addresses.
            candidateAddresses:
              opts.candidateAddresses ?? (() => ["127.0.0.1"]),
            tunnelUrl: opts.tunnelUrl,
          }),
          { validateOutputs: true },
        ),
      },
      track,
    ),
    bootDevice(
      stub,
      opts.clientDeviceId ?? "A",
      { onChange: opts.clientOnChange },
      track,
    ),
  ]);
  return { host, client };
}

// The whole direct wire the transfer checks share, exactly as
// production composes it: the stub device hub, a REAL ticket-mode
// listener on device A serving the check's contracts, the brokered hub
// pair (A hosting the broker, B the dialing client), the REAL shared
// composition as B's bridge, and a counting peer transport aimed at A.
// The plane's presence path is wired to the client connection exactly
// as production wires it (late-bound, plus one catch-up call for the
// roster that connected before the plane existed), so the KEEPER is
// what establishes the B->A session -- eagerly, before any invoke,
// which is the supervised model the transfer checks now ride.
// Everything registers its teardown on the caller's tracker.
export async function bootDirectWire(track, opts = {}) {
  const stub = await startStubHub();
  track(() => stub.close());
  const listener = await startDirectListener(track, {
    deviceId: "A",
    registerHandlers: opts.registerHandlers,
  });
  let onPlaneChange = null;
  const { client } = await bootBrokeredPair(stub, track, listener, {
    hostDeviceId: "A",
    clientDeviceId: "B",
    clientOnChange: () => onPlaneChange?.(),
  });
  const { plane, bridge } = makeDirectBridge(client, { localDeviceId: "B" });
  track(() => plane.stop());
  onPlaneChange = () => plane.handleConnectionChange();
  plane.handleConnectionChange();
  await waitFor(
    () => bridge.directPeerVersions().A !== undefined,
    "the keeper to establish the direct session to A",
  );
  const peerA = bridgePeerTransport(bridge, "A");
  return { stub, listener, client, plane, bridge, peerA };
}

// The client-side composition under test: the REAL direct plane
// (dialer over the connection's broker leg, bridge cache over the
// dialer) exactly as main and the web bridge assemble it. The fan-out
// sinks are observation seams the scenarios read, and the deadline
// is shrunk so failure scenarios settle fast.
export function makeDirectBridge(client, opts = {}) {
  const plane = createDirectPlane({
    connection: () => client.connection,
    localDeviceId: () => opts.localDeviceId ?? "A",
    localAppVersion: () => "1.0.0",
    broadcastStatus: (status) => opts.onStatusChange?.(status),
    broadcastPeerPush: (push) => opts.onPeerPush?.(push),
    dialableKinds: opts.dialableKinds,
    // The production socket (main injects ws), so the proof exercises
    // the errno detail the seam exists for rather than the bare 1006
    // of Node's global.
    openSocket: (url) => new WsClient(url),
    deadlineMs: opts.deadlineMs ?? 3000,
    // The keeper's clock/ladder seam, so retry scenarios advance a
    // fake clock instead of sleeping the real ladder out.
    keeper: opts.keeper,
  });
  return { plane, bridge: plane.handlers };
}

// A ClientTransport riding the bridge's cached direct session, with a
// per-channel invoke counter so a transfer check can pin poll-side
// chunking as round trips (the hub stub sees none of them, which the
// checks assert separately via forwardedCount).
export function bridgePeerTransport(bridge, deviceId) {
  const counts = new Map();
  return {
    transport: {
      invoke: (channel, input) => {
        counts.set(channel, (counts.get(channel) ?? 0) + 1);
        return bridge.invokePeer({ deviceId, channel, input });
      },
      subscribe: () => {
        throw new Error("this test transport is invoke-only");
      },
    },
    invokeCount: (channel) => counts.get(channel) ?? 0,
  };
}
