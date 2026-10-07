// A contract's schemas are zod or Effect Schema while app/shared/schemas
// moves to Schema (V3.md step 1). Everything that reads a contract's
// schemas goes through here, and this file goes with the last zod one.
//
// A converted schema's decoded value serializes to the JSON it decodes
// from, so the wires keep sending values as they are and only decode.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { z } from "zod";

export type ContractSchema = z.ZodTypeAny | Schema.Codec<unknown, unknown>;

// The wire shape a producer hands over, and the decoded shape a
// consumer sees.
export type Encoded<S> = S extends Schema.Top
  ? S["Encoded"]
  : S extends z.ZodTypeAny
    ? z.input<S>
    : never;
export type Decoded<S> = S extends Schema.Top
  ? S["Type"]
  : S extends z.ZodTypeAny
    ? z.output<S>
    : never;

export type DecodeResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

export function safeDecode<S extends ContractSchema>(
  schema: S,
  value: unknown,
): DecodeResult<Decoded<S>>;
export function safeDecode(
  schema: ContractSchema,
  value: unknown,
): DecodeResult<unknown> {
  if (!Schema.isSchema(schema)) {
    const result = schema.safeParse(value);
    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error };
  }
  const result = Schema.decodeUnknownResult(schema)(value);
  return Result.isSuccess(result)
    ? { success: true, data: result.success }
    : { success: false, error: result.failure };
}

// A handler's answer checked against the output schema, as the wire
// will carry it. Effect schemas encode it, since the answer is a
// decoded value.
export function encode<S extends ContractSchema>(
  schema: S,
  value: Decoded<S>,
): Encoded<S>;
export function encode(schema: ContractSchema, value: unknown): unknown {
  return Schema.isSchema(schema)
    ? Schema.encodeUnknownSync(schema)(value)
    : schema.parse(value);
}

export function decode<S extends ContractSchema>(
  schema: S,
  value: unknown,
): Decoded<S> {
  const result = safeDecode(schema, value);
  if (!result.success) throw result.error;
  return result.data;
}
