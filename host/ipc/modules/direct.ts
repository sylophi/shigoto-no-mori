// Host side of the direct data plane's brokering surface. A factory rather than a plain handler object because the
// deps are owned by whoever assembled the direct listener: main wires
// the real listener status, ticket store and hub roster in, and the
// direct-plane check drives the same factory with its own instances.
//
// This file must stay Electron free (host:check).
import {
  ALL_DIRECT_CANDIDATE_KINDS,
  type DirectCandidate,
  type DirectCandidateKind,
  type DirectConnectInfo,
  type DirectConnectInfoInput,
  directContract,
} from "@shared/ipc/modules/direct";
import { wrapContractCall } from "@shared/ipc/registerContract";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import type { HubBroker, HubBrokerContext } from "@shared/hub/link";
import { candidateAddresses } from "@host/direct/addresses";

// The one context fact connectInfo reads. Both the full HandlerContext
// (the Electron and direct wires through the shared registrar) and the
// hub's minimal HubBrokerContext satisfy it, which is what lets
// one handler serve every wire without a no-op notifier being minted
// for the device hub's sake.
export type ConnectInfoContext = Pick<HandlerContext, "callerDeviceId">;

export type DirectHandlerDeps = {
  // The direct listener's bound port, or null while it is not running
  // (not enrolled, bind failed, or the platform cannot listen).
  listenerPort(): number | null;
  // Mints one single-use connect ticket per candidate, all bound to
  // the named peer, replacing that peer's previous pending set. Null
  // means the store refused (global backstop cap).
  mintTickets(peerDeviceId: string, count: number): string[] | null;
  // Whether the named peer is currently in the device hub's live
  // presence roster. connectInfo can arrive over an existing direct
  // socket too, and presence is what scopes the data plane (a revoked
  // device drops off the roster), so a caller the control plane no
  // longer vouches for must not re-mint tickets over its own direct
  // wire.
  isPeerOnline(peerDeviceId: string): boolean;
  // The wss URL of this host's tunnel endpoint while the cloudflared
  // child is currently healthy, else null. When
  // present it is advertised as one more candidate with its own
  // ticket. Absent means no tunnel support, so slice A callers change
  // nothing.
  tunnelUrl?(): string | null;
  // Test seam for the interface enumeration.
  candidateAddresses?(): string[];
};

// Bracket IPv6 literals so they survive URL parsing on the dialing
// side.
function lanUrlOf(address: string, port: number): string {
  const host = address.includes(":") ? `[${address}]` : address;
  return `ws://${host}:${port}`;
}

export function makeDirectHandlers(
  deps: DirectHandlerDeps,
): Handlers<typeof directContract, ConnectInfoContext> {
  return {
    connectInfo: (input: DirectConnectInfoInput, ctx): DirectConnectInfo => {
      // Fail closed without an authenticated peer identity: a ticket
      // is bound to the deviceId it is minted for, and only the hub
      // link and the direct listener supply one. Every other wire
      // (Electron, legacy LAN, loopback) reads as unavailable.
      const peerDeviceId = ctx.callerDeviceId;
      if (peerDeviceId === undefined) return { available: false };
      if (!deps.isPeerOnline(peerDeviceId)) return { available: false };
      const port = deps.listenerPort();
      if (port === null) return { available: false };
      // Mint only what the caller declared it can dial: a web caller
      // (["tunnel"]) must not be handed lan tickets it will burn and
      // abandon on every broker call. An absent field is an old caller
      // and means all kinds (skew tolerance).
      const callerKinds = new Set<DirectCandidateKind>(
        input?.dialableKinds ?? ALL_DIRECT_CANDIDATE_KINDS,
      );
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
      const tunnelUrl = deps.tunnelUrl?.() ?? null;
      if (callerKinds.has("tunnel") && tunnelUrl !== null) {
        dialable.push({ kind: "tunnel", url: tunnelUrl });
      }
      if (dialable.length === 0) return { available: false };
      // One ticket per candidate, so the dialer's concurrent race
      // burns at most one ticket per candidate that actually reached
      // us.
      const tickets = deps.mintTickets(peerDeviceId, dialable.length);
      if (tickets === null) return { available: false };
      return {
        available: true,
        candidates: dialable.map((candidate, index) => ({
          kind: candidate.kind,
          url: candidate.url,
          ticket: tickets[index],
        })),
      };
    },
  };
}

// The channel-plus-handler pair the hub binding's one broker slot
// takes (HubBroker in link.ts), built on the shared registrar's own
// per-call wrapper so the brokered path serves EXACTLY the policy
// every other wire does (unconditional input parse, hooks, dev-gated
// output parse) and can never silently diverge when that policy
// changes. The hooks no-op here by construction: connectInfo is an
// untracked read, so wrapContractCall resolves both to undefined. The
// hub binding is deliberately not a ServerTransport, and both real
// wirings (main/ipc/register.ts and the check fixtures) share this.
export function brokerHandlerFor(
  handlers: Handlers<typeof directContract, ConnectInfoContext>,
  opts: { validateOutputs: boolean },
): Required<HubBroker> {
  const def = directContract.calls.connectInfo;
  return {
    channel: def.channel,
    handler: wrapContractCall<HubBrokerContext>(
      def,
      // The cast narrows the wrapper's post-parse unknown back to the
      // schema's own inferred type, mirroring the registrar loop.
      (input, ctx) =>
        handlers.connectInfo(input as DirectConnectInfoInput, ctx),
      opts,
    ),
  };
}
