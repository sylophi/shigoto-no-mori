import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { HexId32Schema } from "@shared/ipc/hexId";
import { DeviceIdSchema } from "@shared/hub/protocol";

// Client-scoped control surface for the port-forward engine (v2 step 8,
// slice B). The engine binds real TCP listeners on THIS machine's
// loopback (main/portForward/engine.ts) and drives a peer's host-scoped
// forward verbs (forward.ts) underneath, so these calls belong to the
// window's own device exactly like dialog and updater: they never mount
// on a remote wire, and the web loopback rejects them fail-closed
// (unclassified client channels). That refusal is correct, not a gap: a
// browser cannot bind a local port, so the feature is app-only and the
// UI additionally gates itself on window.api.isElectron.

// forwardIds are engine-minted (shared/ipc/hexId.ts pins the shape)
// for the same reason forward.ts pins connIds: a caller can only name
// a forward it was told about.
const ForwardIdSchema = HexId32Schema;

// Exported so the UI's port-input parsing shares this exact bound
// instead of restating 1..65535.
export const PortSchema = z.number().int().min(1).max(65535);

export const PortForwardStartPayloadSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  remotePort: PortSchema,
  // Omitted means an ephemeral local port, the common case.
  localPort: PortSchema.optional(),
});

export const PortForwardStartResultSchema = z.strictObject({
  forwardId: ForwardIdSchema,
  localPort: PortSchema,
});

export const PortForwardStopPayloadSchema = z.strictObject({
  forwardId: ForwardIdSchema,
});

export const PortForwardSummarySchema = z.strictObject({
  forwardId: ForwardIdSchema,
  deviceId: DeviceIdSchema,
  remotePort: PortSchema,
  localPort: PortSchema,
  connCount: z.number().int().min(0),
});

export const PortForwardListResultSchema = z.strictObject({
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
