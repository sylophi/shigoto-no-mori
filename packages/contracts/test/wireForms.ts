import * as Schema from "effect/Schema";

export const json = (value: unknown) => JSON.stringify(value);

// The JSON forms a value takes on its way through the schema: the
// decoded value (what the wires send as it is) and its encoding.
export function wireForms(
  schema: Schema.Codec<unknown, unknown>,
  value: unknown,
): string[] {
  const decoded = Schema.decodeUnknownSync(schema)(value);
  return [json(decoded), json(Schema.encodeSync(schema)(decoded))];
}
