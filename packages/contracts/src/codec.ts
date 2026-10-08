// How a contract's schemas are read: the registrar, the push watchers,
// the lab bridge, the web stubs and the JSON file readers decode
// through here.
//
// A schema's decoded value serializes to the JSON it decodes from, so
// the wires send values as they are and only decode.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type ContractSchema = Schema.Codec<unknown, unknown>;

// The wire shape a producer hands over, and the decoded shape a
// consumer sees.
export type Encoded<S extends ContractSchema> = S["Encoded"];
export type Decoded<S extends ContractSchema> = S["Type"];

export type DecodeResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

export function safeDecode<S extends ContractSchema>(
  schema: S,
  value: unknown,
): DecodeResult<Decoded<S>> {
  const result = Schema.decodeUnknownResult(schema)(value);
  return Result.isSuccess(result)
    ? { success: true, data: result.success }
    : { success: false, error: result.failure };
}

// A handler's answer checked against the output schema, as the wire
// will carry it.
export function encode<S extends ContractSchema>(
  schema: S,
  value: Decoded<S>,
): Encoded<S> {
  return Schema.encodeUnknownSync(schema)(value);
}

export function decode<S extends ContractSchema>(
  schema: S,
  value: unknown,
): Decoded<S> {
  const result = safeDecode(schema, value);
  if (!result.success) throw result.error;
  return result.data;
}
