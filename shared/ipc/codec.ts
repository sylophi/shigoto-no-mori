// A contract schema's codec, and the three calls the wires decode and
// validate with. Every contract input, output and payload is an Effect
// Schema that decodes plain data with no services.
import { Schema } from "effect";

export type AnyCodec = Schema.Codec<unknown, unknown, never, never>;

// The decoded (typed) side of a codec, and the wire (encoded) side.
export type CodecOut<S> = S extends AnyCodec ? S["Type"] : never;
export type CodecIn<S> = S extends AnyCodec ? S["Encoded"] : never;

// Decode or throw: the registrar's unconditional input wall.
export function decodeWith<C extends AnyCodec>(
  codec: C,
  raw: unknown,
): CodecOut<C> {
  return Schema.decodeUnknownSync(codec)(raw) as CodecOut<C>;
}

// Validate a value the program already holds in its decoded shape (a
// handler's result under the dev-only output check, a broadcast
// payload at its producer): the type-side check alone, so a transform
// is never run a second time on a decoded value and the wire keeps
// carrying the decoded shape the renderer reads. Contract outputs are
// JSON-shaped by rule (Type equals Encoded); a Schema whose wire form
// differs belongs behind an explicit encode, not here.
export function validateWith(codec: AnyCodec, value: unknown): unknown {
  if (Schema.is(codec)(value)) return value;
  // Decode for the issue's sake: it names what is wrong.
  return Schema.decodeUnknownSync(codec)(value);
}

export type SafeDecode<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: unknown };

// Decode or report: for a reader that drops a malformed value rather
// than failing on it (a push payload, a frame).
export function safeDecodeWith<C extends AnyCodec>(
  codec: C,
  raw: unknown,
): SafeDecode<CodecOut<C>> {
  try {
    const data = Schema.decodeUnknownSync(codec)(raw) as CodecOut<C>;
    return { success: true, data };
  } catch (error) {
    return { success: false, error };
  }
}
