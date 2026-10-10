import * as Schema from "effect/Schema";
import { WorktreeScopedPayloadSchema } from "./payloads.ts";

const TerminalIdPayloadSchema = Schema.Struct({
  terminalId: Schema.NonEmptyString,
});

// Who a terminal belongs to: a worktree, which it starts in and closes
// with, or the device, where it starts in the last folder used and
// lives as long as the host.
export const TerminalOwnerSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("worktree"),
    ...WorktreeScopedPayloadSchema.fields,
  }),
  Schema.Struct({ kind: Schema.Literal("device") }),
]);
export type TerminalOwner = typeof TerminalOwnerSchema.Type;

const GridSizeSchema = Schema.Struct({
  cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
});

const TerminalSchema = Schema.Struct({
  terminalId: Schema.NonEmptyString,
  owner: TerminalOwnerSchema,
  // The folder it started in.
  cwd: Schema.String,
  // Epoch ms.
  openedAt: Schema.Number,
});
export type Terminal = typeof TerminalSchema.Type;

export const TerminalsSchema = Schema.Struct({
  terminals: Schema.Array(TerminalSchema),
});

export const OpenTerminalPayloadSchema = Schema.Struct({
  owner: TerminalOwnerSchema,
  // The grid the opening client has room for.
  size: Schema.optional(GridSizeSchema),
});

export const CloseTerminalPayloadSchema = TerminalIdPayloadSchema;

export const AttachTerminalPayloadSchema = Schema.Struct({
  ...TerminalIdPayloadSchema.fields,
  // The last chunk's seq the client holds, when it is reconnecting.
  after: Schema.optional(Schema.Natural),
});

// What an attach streams, in order: the history (after `after` when the
// ring still holds it, else all of it with `reset`, and the client
// starts over), the size, then output and size changes as they come,
// then the exit. A chunk's `seq` counts the session's output chunks, so
// a reconnect asks for what came after the last one it holds.
export const TerminalEventSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("history"),
    data: Schema.String,
    seq: Schema.Natural,
    reset: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("output"),
    data: Schema.String,
    seq: Schema.Natural,
  }),
  Schema.Struct({ kind: Schema.Literal("size"), ...GridSizeSchema.fields }),
  Schema.Struct({
    kind: Schema.Literal("exit"),
    code: Schema.NullOr(Schema.Int),
  }),
]);
export type TerminalEvent = typeof TerminalEventSchema.Type;

export const WriteTerminalPayloadSchema = Schema.Struct({
  ...TerminalIdPayloadSchema.fields,
  data: Schema.String,
});

export const ResizeTerminalPayloadSchema = Schema.Struct({
  ...TerminalIdPayloadSchema.fields,
  ...GridSizeSchema.fields,
});
