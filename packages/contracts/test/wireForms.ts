import * as SchemaBinary from "effect/encoding/SchemaBinary";
import * as Schema from "effect/Schema";

export const json = (value: unknown) => JSON.stringify(value);

// A value as the binary codec keeps it: fields in their declared order
// rather than the sample's, and a lone surrogate (which derived samples
// hold, and no id, path or text a device reads does) as U+FFFD, since
// UTF-8 cannot carry one.
const wellFormed = (text: string) =>
  text.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "\ufffd",
  );

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, part: unknown) => {
    if (typeof part === "string") return wellFormed(part);
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      return part;
    }
    return Object.fromEntries(
      Object.entries(part)
        .map(([key, field]) => [wellFormed(key), field] as const)
        .toSorted(([a], [b]) => a.localeCompare(b)),
    );
  });

// The JSON forms a value takes on its way through the schema: its
// encoding, the decoded value (which an in-process registrar, the web
// client's or the fake host's, hands over as it is), and the value back
// through the device link's binary codec. The link's own calls
// (modules/link.ts) never cross a registrar, and carry

// bytes, which their samples hold as JSON's base64.

export function wireForms(
  schema: Schema.Codec<unknown, unknown>,
  value: unknown,
  options: { readonly bridged: boolean },
): string[] {
  const codec = options.bridged ? schema : Schema.toCodecJson(schema);
  const decoded = Schema.decodeUnknownSync(codec)(value);
  const binary = SchemaBinary.toCodec(schema);
  const throughBinary = Schema.encodeUnknownSync(codec)(
    Schema.decodeUnknownSync(binary)(Schema.encodeUnknownSync(binary)(decoded)),
  );
  return [
    json(Schema.encodeUnknownSync(codec)(decoded)),
    canonical(throughBinary) === canonical(value)
      ? json(value)
      : json(throughBinary),
    ...(options.bridged ? [json(decoded)] : []),
  ];
}
