import * as Schema from "effect/Schema";
import { WorktreeScopedPayloadSchema } from "./payloads.ts";
import { HexId32Schema } from "./hexId.ts";

const TerminalIdPayloadSchema = Schema.Struct({
  terminalId: Schema.NonEmptyString,
});

const GridSizeSchema = Schema.Struct({
  cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
});

// A terminal belongs to the worktree it starts in, and closes with it.
const TerminalSchema = Schema.Struct({
  terminalId: Schema.NonEmptyString,
  ...WorktreeScopedPayloadSchema.fields,
  // Epoch ms.
  openedAt: Schema.Finite,
});
export type Terminal = typeof TerminalSchema.Type;

export const TerminalsSchema = Schema.Struct({
  terminals: Schema.Array(TerminalSchema),
});

export const OpenTerminalPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  // The grid the opening client has room for.
  size: Schema.optional(GridSizeSchema),
});

export const CloseTerminalPayloadSchema = TerminalIdPayloadSchema;

// A point in a terminal's output: its shell's incarnation (a restart
// starts another) and a chunk's seq in it.
const TerminalMarkSchema = Schema.Struct({
  incarnation: HexId32Schema,
  seq: Schema.Natural,
});

export const AttachTerminalPayloadSchema = Schema.Struct({
  ...TerminalIdPayloadSchema.fields,
  // The last chunk the client holds, when it is reconnecting.
  after: Schema.optional(TerminalMarkSchema),
});

// What an attach streams, in order: the history (after `after` when the
// ring still holds it in the same incarnation, else all of it with
// `reset`, and the client starts over), the size, then output and size
// changes as they come, then the exit. A chunk's `seq` counts the
// incarnation's output chunks, so a reconnect asks for what came after
// the last one it holds.
export const TerminalEventSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("history"),
    data: Schema.String,
    ...TerminalMarkSchema.fields,
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
