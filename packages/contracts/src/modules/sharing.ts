import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke, view } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";

// Whether this device shares with the account's other devices at all,
// the switch on its account page (the device setting
// shareWithDevices). Off, its device link refuses every call a peer
// makes, reads included, and pushes peers nothing (SharingGate,
// link.ts), so they see a device with nothing on it. The mirrors this
// device asked for are the one exception (host/mirror/invites.ts).
export const sharingContract = defineContract(
  "sharing",
  "host",
  // This device's own: no peer reads or flips it.
  invoke("read", VoidSchema, Schema.Boolean, { remote: false, gated: false }),
  view("watch", VoidSchema, Schema.Boolean, { remote: false, gated: false }),
  invoke("set", Schema.Boolean, VoidSchema, { remote: false, gated: true }),
  // The switch as it now stands. A peer hears it whether or not this
  // device shares, beside the connectInfo answer's sharesData: it is
  // how the peer's status follows the switch (HubStatus.peerSharesData).
  broadcast("changed", Schema.Boolean, { remote: true }),
);
