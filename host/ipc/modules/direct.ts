// Host side of the direct data plane's brokering surface (v2 step 10,
// slice A). A factory rather than a plain handler object because the
// deps are owned by whoever assembled the direct listener: main wires
// the real listener status, ticket store and relay roster in, and the
// direct-plane check drives the same factory with its own instances.
//
// This file must stay Electron free (host:check).
import {
  type DirectConnectInfo,
  directContract,
} from "@shared/ipc/modules/direct";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { candidateAddresses } from "@host/direct/addresses";

export type DirectHandlerDeps = {
  // The direct listener's bound port, or null while it is not running
  // (not enrolled, bind failed, or the platform cannot listen).
  listenerPort(): number | null;
  // Mints one single-use connect ticket per candidate, all bound to
  // the named peer, replacing that peer's previous pending set. Null
  // means the store refused (global backstop cap).
  mintTickets(peerDeviceId: string, count: number): string[] | null;
  // Whether the named peer is currently in the relay's live presence
  // roster. connectInfo can arrive over an existing direct socket too,
  // and presence is what scopes the data plane (a revoked device drops
  // off the roster), so a caller the control plane no longer vouches
  // for must not re-mint tickets over its own direct wire.
  isPeerOnline(peerDeviceId: string): boolean;
  // Test seam for the interface enumeration.
  candidateAddresses?(): string[];
};

export function makeDirectHandlers(
  deps: DirectHandlerDeps,
): Handlers<typeof directContract, HandlerContext> {
  return {
    connectInfo: (_input, ctx): DirectConnectInfo => {
      // Fail closed without an authenticated peer identity: a ticket
      // is bound to the deviceId it is minted for, and only the relay
      // link and the direct listener supply one. Every other wire
      // (Electron, legacy LAN, loopback) reads as unavailable.
      const peerDeviceId = ctx.callerDeviceId;
      if (peerDeviceId === undefined) return { available: false };
      if (!deps.isPeerOnline(peerDeviceId)) return { available: false };
      const port = deps.listenerPort();
      if (port === null) return { available: false };
      const addresses = (deps.candidateAddresses ?? candidateAddresses)();
      if (addresses.length === 0) return { available: false };
      // One ticket per candidate, aligned by index with addresses, so
      // the dialer's concurrent race burns at most one ticket per
      // candidate that actually reached us.
      const tickets = deps.mintTickets(peerDeviceId, addresses.length);
      if (tickets === null) return { available: false };
      return { available: true, port, addresses, tickets };
    },
  };
}
