// A contract schema during the zod-to-Schema port (EFFECT-MIGRATION.md,
// Phase 4): a contract may name a zod schema or an Effect Schema for
// its input, output or payload, and the wires decode either through
// these two functions. Both libraries agree on the contract's meaning
// (decode untrusted data into the typed shape, or refuse it); only the
// call differs. Deleted with zod once the last schema has moved.
import { Schema, SchemaIssue } from "effect";
import type { z } from "zod";

// An Effect Schema a wire can decode with no services: what a contract
// schema is (validation of plain data, never a lookup).
export type EffectCodec = Schema.Codec<unknown, unknown, never, never>;

export type AnyCodec = z.ZodTypeAny | EffectCodec;

// The decoded (typed) side of a codec, and the wire (encoded) side.
// For a zod schema these are z.output and z.input; for a Schema its
// Type and Encoded.
export type CodecOut<S> = S extends z.ZodTypeAny
  ? z.output<S>
  : S extends EffectCodec
    ? S["Type"]
    : never;
export type CodecIn<S> = S extends z.ZodTypeAny
  ? z.input<S>
  : S extends EffectCodec
    ? S["Encoded"]
    : never;

export function isZodCodec(codec: AnyCodec): codec is z.ZodTypeAny {
  return (
    typeof (codec as { safeParse?: unknown }).safeParse === "function" &&
    typeof (codec as { parse?: unknown }).parse === "function"
  );
}

// Decode or throw: the registrar's unconditional input wall.
export function decodeWith<C extends AnyCodec>(
  codec: C,
  raw: unknown,
): CodecOut<C> {
  if (isZodCodec(codec)) return codec.parse(raw) as CodecOut<C>;
  return Schema.decodeUnknownSync(codec)(raw) as CodecOut<C>;
}

// Validate a value the program already holds in its decoded shape (a
// handler's result under the dev-only output check, a broadcast
// payload at its producer). For zod that is `.parse`, which also
// applies defaults, as it always did; for a Schema it is the type-side
// check alone, so a transform is never run a second time on a decoded
// value and the wire keeps carrying the decoded shape the renderer
// reads. Contract outputs are JSON-shaped by rule (Type equals
// Encoded); a Schema whose wire form differs belongs behind an explicit
// encode, not here.
export function validateWith(codec: AnyCodec, value: unknown): unknown {
  if (isZodCodec(codec)) return codec.parse(value);
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
  if (isZodCodec(codec)) {
    return codec.safeParse(raw) as SafeDecode<CodecOut<C>>;
  }
  try {
    const data = Schema.decodeUnknownSync(codec)(raw) as CodecOut<C>;
    return { success: true, data };
  } catch (error) {
    return { success: false, error };
  }
}

// Whether a decode failure is the schema refusing the value (as opposed
// to a bug in a transform), for logs that name the cause.
export function isSchemaRefusal(error: unknown): boolean {
  return (
    SchemaIssue.isIssue?.(error) === true ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error.name === "ZodError" || error.name === "SchemaError"))
  );
}
