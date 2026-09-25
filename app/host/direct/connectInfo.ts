// Host side of the direct data plane's brokering: the answer to a
// peer's connectInfo ask over the device hub (shared/hub/link.ts). A
// factory rather than a plain function because the deps are owned by
// whoever assembled the direct listener: main wires the real listener
// status, ticket store and tunnel runner in, and the direct-plane check
// drives the same factory with its own instances.
//
// This file must stay Electron free (pnpm test host-boundary).
import {
  type DirectCandidate,
  type DirectCandidateKind,
  type DirectConnectInfo,
  DirectConnectInfoInputSchema,
} from "@shared/ipc/modules/direct";
import { candidateAddresses } from "@host/direct/addresses";

type ConnectInfoDeps = {
  // The direct listener's bound port, or null while it is not running
  // (not enrolled, bind failed, or the platform cannot listen).
  listenerPort(): number | null;
  // Mints one single-use connect ticket per candidate, in the order the
  // kinds are given, all bound to the named peer and replacing that
  // peer's previous pending set. Each ticket carries the kind it was
  // minted for, so it can only be redeemed on a connection that
  // actually arrived that way. Null means the store refused (global
  // backstop cap).
  mintTickets(
    peerDeviceId: string,
    kinds: readonly DirectCandidateKind[],
  ): string[] | null;
  // The wss URL of this host's tunnel endpoint while the cloudflared
  // child is currently healthy, else null. When present it is
  // advertised as one more candidate with its own ticket.
  tunnelUrl(): string | null;
  // Test seam for the interface enumeration.
  candidateAddresses?(): string[];
};

// Bracket IPv6 literals so they survive URL parsing on the dialing
// side.
function lanUrlOf(address: string, port: number): string {
  const host = address.includes(":") ? `[${address}]` : address;
  return `ws://${host}:${port}`;
}

// The link's ServeConnectInfo: the caller is the deviceId the device
// hub stamped on the ask, already checked against the live roster, and
// the raw input is parsed here (a malformed one throws, which the link
// answers as a refusal).
export function makeConnectInfo(
  deps: ConnectInfoDeps,
): (callerDeviceId: string, rawInput: unknown) => DirectConnectInfo {
  return (callerDeviceId, rawInput) => {
    const input = DirectConnectInfoInputSchema.parse(rawInput);
    const port = deps.listenerPort();
    if (port === null) return { available: false };
    // Mint only what the caller declared it can dial: a web caller
    // (["tunnel"]) must not be handed lan tickets it will burn and
    // abandon on every ask.
    const callerKinds = new Set<DirectCandidateKind>(input.dialableKinds);
    const dialable: Array<Pick<DirectCandidate, "kind" | "url">> = [];
    if (callerKinds.has("lan")) {
      const addresses = (deps.candidateAddresses ?? candidateAddresses)();
      for (const address of addresses) {
        dialable.push({ kind: "lan", url: lanUrlOf(address, port) });
      }
    }
    // The tunnel is one more candidate, advertised only while the
    // cloudflared child is healthy: a stale hostname would only burn
    // a ticket on a dead racer, but a healthy tunnel must always be
    // offered so a peer with no route to any interface address stays
    // dialable (data is direct or nothing, there is no hub
    // fallback).
    const tunnelUrl = deps.tunnelUrl();
    if (callerKinds.has("tunnel") && tunnelUrl !== null) {
      dialable.push({ kind: "tunnel", url: tunnelUrl });
    }
    if (dialable.length === 0) return { available: false };
    // One ticket per candidate, so the dialer's concurrent race
    // burns at most one ticket per candidate that actually reached
    // us.
    const tickets = deps.mintTickets(
      callerDeviceId,
      dialable.map((candidate) => candidate.kind),
    );
    if (tickets === null) return { available: false };
    return {
      available: true,
      candidates: dialable.map((candidate, index) => ({
        kind: candidate.kind,
        url: candidate.url,
        ticket: tickets[index],
      })),
    };
  };
}
