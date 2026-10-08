import * as Schema from "effect/Schema";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { broadcast, defineContract, invoke } from "../contract.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import {
  PortNumberSchema,
  VoidSchema,
  WorktreeScopedPayloadSchema,
} from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// Client-scoped control surface for the port-forward engine. The engine
// binds real TCP listeners on THIS machine's loopback
// (main/core/portForward/engine.ts) and drives a peer's host-scoped
// forward verbs (forward.ts) underneath, so these calls belong to the
// window's own device exactly like dialog and updater: they never mount
// on a remote wire, and the web loopback rejects them fail-closed
// (unclassified client channels). That refusal is correct, not a gap: a
// browser cannot bind a local port, so the feature is app-only and the
// UI additionally gates itself on window.api.isElectron.

// forwardIds are engine-minted (schemas/hexId.ts pins the shape)
// for the same reason forward.ts pins channel ids: a caller can only name
// a forward it was told about.
const ForwardIdSchema = HexId32Schema;

// The peer's worktree a forward was switched on from (its port list),
// so the sidebar can say that worktree is being forwarded without
// reading every peer worktree's port list. Absent for a forward started
// from the account page. A label only: the engine forwards by (device,
// port) either way, and the list's switches match by port, so a forward
// another worktree (or the devices page) started shows on in the list
// but marks only its own worktree.
const PortForwardWorktreeSchema = WorktreeScopedPayloadSchema;

export type PortForwardWorktree = typeof PortForwardWorktreeSchema.Type;

const PortForwardStartPayloadSchema = strict(
  Schema.Struct({
    deviceId: DeviceIdSchema,
    remotePort: PortNumberSchema,
    // Omitted means an ephemeral local port, the common case.
    localPort: Schema.optional(PortNumberSchema),
    worktree: Schema.optional(PortForwardWorktreeSchema),
  }),
);

const PortForwardStartResultSchema = strict(
  Schema.Struct({
    forwardId: ForwardIdSchema,
    localPort: PortNumberSchema,
  }),
);

const PortForwardStopPayloadSchema = strict(
  Schema.Struct({
    forwardId: ForwardIdSchema,
  }),
);

const PortForwardSummarySchema = strict(
  Schema.Struct({
    forwardId: ForwardIdSchema,
    deviceId: DeviceIdSchema,
    remotePort: PortNumberSchema,
    localPort: PortNumberSchema,
    connCount: Schema.Natural,
    worktree: Schema.optional(PortForwardWorktreeSchema),
  }),
);

export type PortForwardSummary = typeof PortForwardSummarySchema.Type;

const PortForwardListResultSchema = strict(
  Schema.Struct({
    forwards: Schema.Array(PortForwardSummarySchema),
  }),
);

export const portForwardContract = defineContract("client", {
  start: invoke(
    "portForward:start",
    PortForwardStartPayloadSchema,
    PortForwardStartResultSchema,
  ),
  stop: invoke("portForward:stop", PortForwardStopPayloadSchema, VoidSchema),
  list: invoke("portForward:list", VoidSchema, PortForwardListResultSchema),
  // Fired by the engine whenever the forward or conn set changes, so
  // the list query refreshes without polling. Payload-free on purpose:
  // the list read is cheap and one signal shape cannot drift.
  changed: broadcast("portForward:changed", VoidSchema),
});
