import { Schema, SchemaIssue } from "effect";

// z.strictObject for Effect Schema: a struct that REFUSES a key it does
// not declare, where Schema.Struct strips it. The wire payloads use it
// as a security property (a remote DeviceSettingsPatch cannot carry
// `socketHost`), so the refusal is per schema, not a decode option:
// onExcessProperty "error" is only a decode-call option and would make
// every nested struct strict too.
//
// Only this level is strict, as with zod: a nested plain Schema.Struct
// still strips its unknown keys. Type and Encoded are those of
// Schema.Struct(fields), and a success decodes to exactly the declared
// keys, like Schema.Struct.
//
// How: the struct takes a rest of Record(String, Unknown), so its parse
// carries every undeclared own enumerable key through to the output
// (declared keys keep their field's decode, and a `__proto__` key lands
// as an own property, never the prototype), and a check on that output
// refuses any key not in `fields`. Because the check sits on the type
// side, Schema.is refuses excess keys too. Checking the encoded side
// instead (a pre-schema piped into decodeTo, or flip/check/flip) would
// keep the refusal out of Schema.is, which then passes an input with
// `socketHost` still on it.
//
// The pick recipe (zod's z.strictObject(X.pick({...}).shape)): pick the
// fields, not the schema, since only `fields` is shared:
//
//   strictStruct(Struct.pick(GlobalConfigSchema.fields, ["launchers", ...]))
//
// with Struct from "effect", once GlobalConfigSchema is a
// Schema.Struct (Struct.pick keeps the field schemas, so a picked key's
// shape cannot drift from the full config's). A strict schema's own `fields` feed a pick
// or a spread the same way. Methods that build a new struct
// (Schema.Struct(...).mapFields, a spread of `fields` into
// Schema.Struct) give a plain, stripping struct: call strictStruct
// again on the result.

// Schema.Struct(fields)'s codec. A type alias because oxlint's
// import/namespace rule reads a namespace member in `extends` as a
// value and does not find the type-only Codec.
type StructCodec<Fields extends Schema.Struct.Fields> = Schema.Codec<
  Schema.Struct.Type<Fields>,
  Schema.Struct.Encoded<Fields>,
  Schema.Struct.DecodingServices<Fields>,
  Schema.Struct.EncodingServices<Fields>
>;

export interface StrictStruct<
  Fields extends Schema.Struct.Fields,
> extends StructCodec<Fields> {
  readonly Rebuild: StrictStruct<Fields>;
  readonly fields: Fields;
}

export function strictStruct<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
): StrictStruct<Fields> {
  const declared = new Set(Object.keys(fields));
  const open = Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]);
  const refuseUndeclared = Schema.makeFilter<Record<string, unknown>>(
    (value, _ast, options) => {
      const issues: Array<Schema.FilterIssue> = [];
      for (const key of Object.keys(value)) {
        if (declared.has(key)) continue;
        // The issue onExcessProperty "error" raises, with a message naming
        // the key. Annotated on the unchecked struct: annotating the
        // checked one (the ast this filter receives) lands the message on
        // its last check, this filter, where the formatter never reads it.
        const { ast } = open.annotate({
          messageUnexpectedKey: `Unexpected key ${JSON.stringify(key)}`,
        });
        issues.push({
          path: [key],
          issue: new SchemaIssue.UnexpectedKey(ast, value[key], options),
        });
        if (options.errors !== "all") break;
      }
      return issues;
    },
  );
  const schema = open.check(refuseUndeclared);
  return Schema.make<StrictStruct<Fields>>(schema.ast, { fields });
}
