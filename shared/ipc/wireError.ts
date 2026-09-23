// How a typed error crosses a wire. A handler raises an Effect tagged
// error (shared/errors.ts); the serving side encodes its tag and
// JSON-safe fields beside the message; the calling side rebuilds a
// WireError that carries the same tag and fields, so the matchers in
// shared/errors.ts behave identically on every wire and on both sides
// of it.
//
// ADDITIVE per the version-skew policy: the encoded form rides an
// optional `error` field next to the `message` every wire already
// carries. An older peer sends no `error`, and a reader falls back to
// the message text.
import { z } from "zod";
import { errorMessageOf, errorTagOf } from "../errorOf.ts";

// A tag plus any JSON fields. Loose so a newer peer's extra fields
// survive the parse and land on the WireError.
export const WireErrorShapeSchema = z.looseObject({
  _tag: z.string().min(1),
  message: z.string(),
});
export type WireErrorShape = z.infer<typeof WireErrorShapeSchema>;

// Keys an Error owns for itself, never copied as fields.
const RESERVED = new Set([
  "_tag",
  "message",
  "name",
  "stack",
  "cause",
  "__proto__",
  "constructor",
  "prototype",
]);

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as object).every((item) =>
    isJsonValue(item, depth + 1),
  );
}

// The wire form of a typed error, or undefined for a plain Error, in
// which case the wire carries the message alone as before. Only own
// enumerable JSON-safe fields ride: an Effect tagged error's fields
// are exactly that, and a WireError rebuilt on a hop in between (main
// forwarding a peer's failure to the renderer) carries its fields the
// same way.
export function encodeWireError(error: unknown): WireErrorShape | undefined {
  const tag = errorTagOf(error);
  if (tag === undefined) return undefined;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error as object)) {
    if (RESERVED.has(key) || !isJsonValue(value)) continue;
    fields[key] = value;
  }
  return { ...fields, _tag: tag, message: errorMessageOf(error) };
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
// Error as message and stack only, dropping the tag and fields; the
// renderer unwraps it where custom properties survive.
export type InvokeEnvelope =
  | { ok: true; value: unknown }
  | { ok: false; message: string; error?: WireErrorShape };

export async function settleEnvelope(
  run: () => Promise<unknown>,
): Promise<InvokeEnvelope> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const encoded = encodeWireError(error);
    return {
      ok: false,
      message: errorMessageOf(error),
      ...(encoded === undefined ? {} : { error: encoded }),
    };
  }
}

export function unwrapEnvelope(envelope: InvokeEnvelope): unknown {
  if (envelope.ok) return envelope.value;
  throw envelope.error === undefined
    ? new Error(envelope.message)
    : new WireError(envelope.error);
}
