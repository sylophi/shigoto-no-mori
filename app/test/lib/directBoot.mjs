// Shared fixtures for the checks that run a REAL direct data plane
// beside the stub device hub (test/lib/hubStub.mjs): a direct ws
// listener (host/socket/server.ts), the connectInfo server on a hub
// host device, and the REAL shared composition
// (shared/hub/directPlane.ts) a client drives. Extracted from
// direct-plane.mjs so sync-transfer.mjs and
// port-forward.mjs move their transfer scenarios onto a real
// direct connection without a second copy of the plumbing. Runs under
// register-ts-alias so the shared TypeScript imports resolve.
import { makeConnectInfo } from "@host/direct/connectInfo";
import { createWsServerBinding } from "@host/socket/server";
import { createConnectTicketStore } from "@host/direct/tickets";
import { createDirectPlane } from "@shared/hub/directPlane";
import { accountContract } from "@shared/ipc/modules/account";
import { broadcastAll, registerContract } from "@shared/ipc/registerContract";
import { WebSocket as WsClient } from "ws";
import { startStubHub } from "./hubStub.mjs";
import { bootDevice } from "./hubBoot.mjs";
import { waitFor } from "./checkKit.mjs";

// A REAL direct listener on an ephemeral loopback port, with its
// ticket store and a toggleable command-access switch (the host-wide
// "accepts commands from its account's devices" answer the real
// binding reads from main). Flipping it pushes the switch to every
// connected peer, as main's broadcastCommandAccessChanged does, so a
// peer's bridge follows it live. `registerHandlers`, when
// set, mounts the check's contracts or test channels on the binding
// before it starts, and `start` overrides the start opts (the hello
// and liveness seams, the admitted web origin).
export async function startDirectListener(track, opts = {}) {
  const tickets = createConnectTicketStore(opts.ticketOpts);
  let accepts = false;
  const binding = createWsServerBinding({
    matchTicket: (deviceId, arrivedAs, matches) =>
      tickets.consumeProven(deviceId, arrivedAs, matches),
    isCommandGranted: () => accepts,
  });
  opts.registerHandlers?.(binding);
  const port = await binding.start({
    port: 0,
    bindAddress: "127.0.0.1",
    deviceId: opts.deviceId ?? "B",
    appVersion: "2.0.0",
    helloTimeoutMs: 1000,
    ...opts.start,
  });
  track(() => binding.stop());
  return {
    binding,
    tickets,
    acceptsCommands: () => accepts,
    setAccepts: (next) => {
      accepts = next;
      broadcastAll(accountContract, "commandAccessChanged", next, binding);
    },
    port,
    listenerPort: () => {
      const status = binding.status();
      return status.listening ? status.port : null;
    },
  };
}

// Boots the hub pair: B answers connectInfo with the REAL server (the
// ONLY thing the hub wire answers, wired as main wires it), A is the
// dialing client. The two devices are independent, so they boot
// concurrently.
export async function bootBrokeredPair(stub, track, listener, opts = {}) {
  const [host, client] = await Promise.all([
    bootDevice(
      stub,
      opts.hostDeviceId ?? "B",
      {
        serveConnectInfo: makeConnectInfo({
          listenerPort: listener.listenerPort,
          mintTickets: (peerDeviceId, kinds) => {
            const tickets = listener.tickets.mint(peerDeviceId, kinds);
            // Observation seam for the mint-alignment assertions.
            if (tickets !== null) opts.onMinted?.(tickets);
            return tickets;
          },
          // Deterministic candidates: the listener binds loopback,
          // so real interface enumeration would offer unreachable
          // LAN addresses.
          candidateAddresses: opts.candidateAddresses ?? (() => ["127.0.0.1"]),
          tunnelUrl: opts.tunnelUrl ?? (() => null),
          // A bare broker stand-in (no real listener behind it)
          // reports the switch off.
          acceptsCommands: () => listener.acceptsCommands?.() ?? false,
        }),
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
// production composes it: the stub device hub, a REAL direct
// listener on device A serving the check's contracts, the brokered hub
// pair (A answering connectInfo, B the dialing client), the REAL shared
// composition as B's bridge, and a counting peer transport aimed at A.
// The plane's presence path is wired to the client connection exactly
// as production wires it (late-bound, plus one catch-up call for the
// roster that connected before the plane existed), so the KEEPER is
// what establishes the B->A session -- eagerly, before any invoke,
// which is the supervised model the transfer checks now ride.
// Everything registers its teardown on the caller's tracker.
// `opts.contracts` lists the [contract, handlers] pairs A serves, each
// registered with output validation and a no-op usage hook: the hook is
// the Electron binding's concern, and the registrar only calls it for
// defs marked tracksProjectUsage (and requires it for a module that has
// one), so passing it everywhere satisfies the registrar and changes
// nothing else.
export async function bootDirectWire(track, opts = {}) {
  const stub = await startStubHub(track);
  const listener = await startDirectListener(track, {
    deviceId: "A",
    registerHandlers: (binding) => {
      for (const [contract, handlers] of opts.contracts ?? []) {
        registerContract(contract, handlers, binding, {
          validateOutputs: true,
          onUsageTracked: () => {},
        });
      }
    },
  });
  let onPlaneChange = null;
  const { client } = await bootBrokeredPair(stub, track, listener, {
    hostDeviceId: "A",
    clientDeviceId: "B",
    clientOnChange: () => onPlaneChange?.(),
  });
  // A's pushes on the session, as main's peer-push fan-out hands them
  // on (main/ipc/register.ts onPeerPush), for the peer transport's
  // subscribe.
  const pushListeners = new Set();
  const { plane, bridge } = makeDirectBridge(client, {
    localDeviceId: "B",
    onPeerPush: (push) => {
      for (const hear of pushListeners) hear(push);
    },
  });
  track(() => plane.stop());
  onPlaneChange = () => plane.handleConnectionChange();
  plane.handleConnectionChange();
  await waitFor(
    () => bridge.directPeerVersions().A !== undefined,
    "the keeper to establish the direct session to A",
  );
  const peerA = bridgePeerTransport(bridge, "A", pushListeners);
  return { stub, listener, client, plane, bridge, peerA };
}

// The client-side composition under test: the REAL direct plane
// (dialer over the connection's connectInfo ask, bridge cache over the
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
// checks assert separately via forwardedCount). Its subscribe hears
// the peer's pushes off the bridge's fan-out, the way main's peer
// transport does.
export function bridgePeerTransport(bridge, deviceId, pushListeners) {
  const counts = new Map();
  return {
    transport: {
      invoke: (channel, input) => {
        counts.set(channel, (counts.get(channel) ?? 0) + 1);
        return bridge.invokePeer({ deviceId, channel, input });
      },
      subscribe: (channel, handler) => {
        const listener = (push) => {
          if (push.deviceId === deviceId && push.channel === channel) {
            handler(push.payload);
          }
        };
        pushListeners.add(listener);
        return () => pushListeners.delete(listener);
      },
    },
    invokeCount: (channel) => counts.get(channel) ?? 0,
    // The session's byte channels (shared/ipc/socket/channels.ts),
    // resolving like invokePeer does.
    channels: () => bridge.peerChannels(deviceId),
  };
}
