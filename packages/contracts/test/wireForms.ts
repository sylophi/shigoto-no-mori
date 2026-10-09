import * as Schema from "effect/Schema";

export const json = (value: unknown) => JSON.stringify(value);

// The JSON forms a value takes on its way through the schema: its
// encoding, what the device link's JSON codec sends, and the decoded
// value, which the Electron bridge sends as it is. The link's own calls
// (modules/link.ts) never cross the bridge, and carry bytes, which only
// the codec writes as JSON.
export function wireForms(
  schema: Schema.Codec<unknown, unknown>,
  value: unknown,
  options: { readonly bridged: boolean },
): string[] {
  const decoded = Schema.decodeUnknownSync(schema)(value);
  const forms = [
    json(Schema.encodeSync(schema)(decoded)),
    json(
      Schema.encodeUnknownSync(Schema.toCodecJson(schema))(
        Schema.decodeUnknownSync(Schema.toCodecJson(schema))(value),
      ),
    ),
  ];
  return options.bridged ? [json(decoded), ...forms] : forms;
}
