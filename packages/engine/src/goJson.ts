// JSON from another program (gh) read as Go's encoding/json reads it
// into a struct: a field that is absent or null takes its zero value,
// and a key nothing models is dropped. A field of the wrong type fails
// the document, as it fails Go's.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

// `schema`, with null and an absent key read as `zero`.
const orZero = <S extends Schema.Top>(schema: S, zero: S["Type"]) =>
  Schema.NullOr(schema).pipe(
    Schema.decodeTo(
      Schema.toType(schema),
      SchemaTransformation.transform<S["Type"], S["Type"] | null>({
        decode: (value) => value ?? zero,
        encode: (value) => value,
      }),
    ),
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  );

export const text = orZero(Schema.String, "");
export const flag = orZero(Schema.Boolean, false);
export const count = orZero(Schema.Int, 0);
export const list = <S extends Schema.Top>(item: S) =>
  orZero(Schema.Array(item), []);
// An object, absent or null read as one with every field at its zero.
export const struct = <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  orZero(schema, Schema.decodeSync(schema)({}));
