import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { HexId32Schema } from "@shared/ipc/hexId";
import { DeviceIdSchema } from "@shared/hub/protocol";
import { PortNumberZod } from "@shared/schemas/zodBridge";
import { WorktreeScopedPayloadSchema } from "@shared/schemas/zodPayloads";

// Client-scoped control surface for the port-forward engine. The engine
// binds real TCP listeners on THIS machine's loopback
// (main/core/portForward/engine.ts) and drives a peer's host-scoped
// forward verbs (forward.ts) underneath, so these calls belong to the
// window's own device exactly like dialog and updater: they never mount
// on a remote wire, and the web loopback rejects them fail-closed
// (unclassified client channels). That refusal is correct, not a gap: a
// browser cannot bind a local port, so the feature is app-only and the
// UI additionally gates itself on window.api.isElectron.

// forwardIds are engine-minted (shared/ipc/hexId.ts pins the shape)
// for the same reason forward.ts pins channel ids: a caller can only name
// a forward it was told about.
const ForwardIdSchema = HexId32Schema;

// The peer's worktree a forward was switched on from (its Ports
// dialog), so the sidebar and the Ports button can say that worktree is
// being forwarded without reading every peer worktree's port list.
// Absent for a forward started from the account page. A label only: the
// engine forwards by (device, port) either way, and the dialog's
// switches match by port, so a forward another worktree (or the devices
// page) started shows on in the dialog but marks only its own worktree.
const PortForwardWorktreeSchema = WorktreeScopedPayloadSchema;

export type PortForwardWorktree = z.infer<typeof PortForwardWorktreeSchema>;

const PortForwardStartPayloadSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  remotePort: PortNumberZod,
  // Omitted means an ephemeral local port, the common case.
  localPort: PortNumberZod.optional(),
  worktree: PortForwardWorktreeSchema.optional(),
});

const PortForwardStartResultSchema = z.strictObject({
  forwardId: ForwardIdSchema,
  localPort: PortNumberZod,
});

const PortForwardStopPayloadSchema = z.strictObject({
  forwardId: ForwardIdSchema,
});

const PortForwardSummarySchema = z.strictObject({
  forwardId: ForwardIdSchema,
  deviceId: DeviceIdSchema,
  remotePort: PortNumberZod,
  localPort: PortNumberZod,
  connCount: z.number().int().min(0),
  worktree: PortForwardWorktreeSchema.optional(),
});

export type PortForwardSummary = z.infer<typeof PortForwardSummarySchema>;

const PortForwardListResultSchema = z.strictObject({
  forwards: z.array(PortForwardSummarySchema),
});

export const portForwardContract = defineContract("client", {
  start: invoke(
    "portForward:start",
    PortForwardStartPayloadSchema,
    PortForwardStartResultSchema,
  ),
  stop: invoke("portForward:stop", PortForwardStopPayloadSchema, z.void()),
  list: invoke("portForward:list", z.void(), PortForwardListResultSchema),
  // Fired by the engine whenever the forward or conn set changes, so
  // the list query refreshes without polling. Payload-free on purpose:
  // the list read is cheap and one signal shape cannot drift.
  changed: broadcast("portForward:changed", z.void()),
});
