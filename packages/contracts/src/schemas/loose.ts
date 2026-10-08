import * as Schema from "effect/Schema";

// A struct that keeps the keys it does not declare, after the ones it does.
export function loose<const Fields extends Schema.Struct.Fields>(
  struct: Schema.Struct<Fields>,
) {
  return Schema.StructWithRest(struct, [
    Schema.Record(Schema.String, Schema.Unknown),
  ]);
}
