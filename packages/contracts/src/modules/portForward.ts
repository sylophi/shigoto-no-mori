import * as Schema from "effect/Schema";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { push, defineContract, invoke } from "../contract.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import {
  PortNumberSchema,
  VoidSchema,
  WorktreeScopedPayloadSchema,
} from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// Client-scoped: the engine binds listeners on this machine's loopback.
// The web client refuses these by design: a browser can't bind a port.

// Engine-minted, so a caller can only name a forward it was told about.
const ForwardIdSchema = HexId32Schema;

// A label for the sidebar only: the engine forwards by (device, port),
// so a forward started elsewhere shows on in any worktree's list.
const PortForwardWorktreeSchema = WorktreeScopedPayloadSchema;

export type PortForwardWorktree = typeof PortForwardWorktreeSchema.Type;

const PortForwardStartPayloadSchema = strict(
  Schema.Struct({
    deviceId: DeviceIdSchema,
    remotePort: PortNumberSchema,
    // Omitted: an ephemeral port.
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

export const portForwardContract = defineContract(
  "portForward",
  "client",
  invoke("start", PortForwardStartPayloadSchema, PortForwardStartResultSchema),
  invoke("stop", PortForwardStopPayloadSchema, VoidSchema),
  invoke("list", VoidSchema, PortForwardListResultSchema),
  // Payload-free: the list read is cheap.
  push("changed", VoidSchema),
);
