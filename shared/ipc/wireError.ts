// How a typed error crosses a wire. A handler raises an Effect tagged
// error (shared/errors.ts). The serving side encodes its tag and
// JSON-safe fields beside the message. The calling side rebuilds a
// WireError that carries the same tag and fields, so the matchers in
// shared/errors.ts behave identically on every wire and on both sides
// of it.
//
// ADDITIVE per the version-skew policy: the encoded form rides an
// optional `error` field next to the `message` every wire already
// carries. An older peer sends no `error`, and a reader falls back to
// the message text.
import { Schema } from "effect";
import { errorMessageOf, errorTagOf } from "../errorOf.ts";

// A tag plus any JSON fields. Loose so a newer peer's extra fields
// survive the parse and land on the WireError: the rest record carries
// every undeclared own key through (a `__proto__` key lands as an own
// property, never the prototype, and the WireError constructor skips
// it with the other reserved keys).
export const WireErrorShapeSchema = Schema.StructWithRest(
  Schema.Struct({
    _tag: Schema.NonEmptyString,
    message: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type WireErrorShape = typeof WireErrorShapeSchema.Type;

// Keys an Error owns for itself, never copied as fields, plus the
// method names a field must not shadow (a `toString` field would make
// String(error) throw) and the ones a thenable or JSON hook would
// hijack.
const RESERVED = new Set([
  "_tag",
  "message",
  "name",
  "stack",
  "cause",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "toJSON",
  "then",
]);

// A field rides only as JSON: finite numbers, plain objects and arrays,
// no cycles.
const isJsonValue = Schema.is(Schema.Json);

// The most of one string field that rides the wire. A field is for a
// matcher or a short note (a port, a reason, git's stderr), never a
// payload: a git failure's stdout can run to megabytes, and the device
// hub caps a whole frame at 64 KiB, so an unbounded field would turn
// one failure into an answer the caller never receives.
export const MAX_WIRE_FIELD_CHARS = 4_096;

// A string field is cut to the bound. A nested value rides only when
// its JSON is within it (no catalogued error nests anything, and a
// peer's rebuilt error could nest a great deal), else it is left out.
function bounded(value: unknown): { keep: boolean; value: unknown } {
  if (typeof value === "string")
    return { keep: true, value: boundedText(value) };
  if (typeof value !== "object" || value === null) return { keep: true, value };
  try {
    return {
      keep: JSON.stringify(value).length <= MAX_WIRE_FIELD_CHARS,
      value,
    };
  } catch {
    return { keep: false, value };
  }
}

// The wire form of a typed error, or undefined for a plain Error, in
// which case the wire carries the message alone as before. Only own
// enumerable JSON-safe fields ride: an Effect tagged error's fields
// are exactly that, and a WireError rebuilt on a hop in between (main
// forwarding a peer's failure to the renderer) carries its fields the
// same way, each bounded (see bounded). The shape's own `message` is
// bounded like a field: every wire carries the full message beside
// this shape and rebuilds from that one (see rebuildWireError), so a
// whole copy here would only double what a long stderr costs against
// the device hub's frame cap. Nothing here throws: the encode runs
// inside the catch blocks that answer a failed call, and an error it
// cannot encode (a field too deep for the JSON check to walk) rides
// as its tag and message alone.
export function encodeWireError(error: unknown): WireErrorShape | undefined {
  const tag = errorTagOf(error);
  if (tag === undefined) return undefined;
  const fields: Record<string, unknown> = {};
  try {
    for (const [key, value] of Object.entries(error as object)) {
      if (RESERVED.has(key) || !isJsonValue(value)) continue;
      const field = bounded(value);
      if (field.keep) fields[key] = field.value;
    }
  } catch {
    return { _tag: tag, message: boundedText(errorMessageOf(error)) };
  }
  return { ...fields, _tag: tag, message: boundedText(errorMessageOf(error)) };
}

function boundedText(text: string): string {
  return text.length > MAX_WIRE_FIELD_CHARS
    ? `${text.slice(0, MAX_WIRE_FIELD_CHARS)}…`
    : text;
}

// The calling side's one rebuild path: the shape's tag and fields with
// the message the frame carried beside it, which is the full text an
// older reader would have shown.
export function rebuildWireError(
  shape: WireErrorShape,
  message: string,
): WireError {
  return new WireError({ ...shape, message });
}

// A failed answer's body on every wire: the message, plus the typed
// form when the error has one.
export type WireFailure = { message: string; error?: WireErrorShape };

export function wireFailure(error: unknown): WireFailure {
  const encoded = encodeWireError(error);
  return {
    message: errorMessageOf(error),
    ...(encoded === undefined ? {} : { error: encoded }),
  };
}

// Its rebuild on the calling side: the typed form when it rode along,
// else a plain Error carrying the message, which is how an older peer's
// failure (and a plain Error's) reads, so the shared/errors.ts
// matchers degrade exactly as they do on an Electron IPC one.
export function rebuildWireFailure(failure: WireFailure): Error {
  return failure.error === undefined
    ? new Error(failure.message)
    : rebuildWireError(failure.error, failure.message);
}

// The calling side's rebuild: an Error whose `_tag` and fields are the
// ones the handler's error carried. Fields land as own enumerable
// properties (through defineProperty, so a hostile key like __proto__
// cannot reach a setter), which is what lets a hop re-encode it.
export class WireError extends Error {
  readonly _tag: string;
  constructor(shape: WireErrorShape) {
    super(shape.message);
    this.name = shape._tag;
    this._tag = shape._tag;
    for (const [key, value] of Object.entries(shape)) {
      if (RESERVED.has(key)) continue;
      Object.defineProperty(this, key, {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
  }
}

// The Electron wire's answer shape. ipcMain.handle resolves one of
// these instead of rejecting, because contextBridge copies a thrown
// Error as message and stack only, dropping the tag and fields. The
// renderer unwraps it where custom properties survive.
export type InvokeEnvelope =
  | { ok: true; value: unknown }
  | ({ ok: false } & WireFailure);

export async function settleEnvelope(
  run: () => Promise<unknown>,
): Promise<InvokeEnvelope> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, ...wireFailure(error) };
  }
}

export function unwrapEnvelope(envelope: InvokeEnvelope): unknown {
  if (envelope.ok) return envelope.value;
  throw rebuildWireFailure(envelope);
}
