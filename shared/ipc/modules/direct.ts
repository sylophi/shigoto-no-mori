import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";

// Brokering surface for the direct data plane (v2 step 10, slice A): a
// peer asks this host, over the relay, how to dial it directly. The
// answer carries the direct listener's bound port, the host's
// candidate addresses, and ONE short-lived single-use connect ticket
// PER candidate address (tickets[i] dials addresses[i]), each bound to
// the CALLING peer's authenticated deviceId
// (HandlerContext.callerDeviceId, populated by the relay link and the
// direct listener, absent on every other wire, so the handler fails
// closed to available:false without a peer identity). Per-candidate
// tickets are what let the dialer race every candidate at once: a
// candidate that reaches the host but loses the race burns only its
// own ticket, never another candidate's.
//
// connectInfo is a read (remote:true, mutating:false): it must work
// pre-grant because the direct wire it brokers enforces the exact same
// read/mutate gate the relay does, so knowing how to dial grants
// nothing that the relay session did not already grant. Every field
// beyond `available` is optional per the version-skew policy: absence
// means the direct plane is unsupported and old peers keep working
// over the relay.

// How long a minted connect ticket stays valid. Long enough for the
// peer's dial to reach us over any candidate address, short enough
// that a stale connectInfo answer cannot be replayed much later.
// Matches the relay worker's connect-ticket TTL. Lives here (not in
// the host's ticket store) so the dialer's failed-dial memo can share
// the one constant without shared/ importing host/.
export const DIRECT_TICKET_TTL_MS = 60_000;

export const DirectConnectInfoSchema = z.object({
  available: z.boolean(),
  port: z.number().int().positive().optional(),
  addresses: z.array(z.string()).optional(),
  tickets: z.array(z.string()).optional(),
});
export type DirectConnectInfo = z.infer<typeof DirectConnectInfoSchema>;

export const directContract = defineContract("host", {
  connectInfo: invoke("direct:connectInfo", z.void(), DirectConnectInfoSchema, {
    remote: true,
    mutating: false,
  }),
});
