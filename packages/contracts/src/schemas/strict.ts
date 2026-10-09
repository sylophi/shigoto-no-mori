import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";

// A struct that refuses a key it does not declare, as zod's
// strictObject did. Only at its own level: a struct nested in it still
// drops unknown keys. Extend one through the struct it wraps (`.struct`).
export function strict<const Fields extends Schema.Struct.Fields>(
  struct: Schema.Struct<Fields>,
) {
  const declared = new Set(Object.keys(struct.fields));
  return Object.assign(
    Schema.declareConstructor<
      Schema.Struct<Fields>["Type"],
      Schema.Struct<Fields>["Encoded"]
    >()(
      [struct],
      ([codec]) =>
        (input, ast, options) => {
          if (
            typeof input === "object" &&
            input !== null &&
            !Array.isArray(input)
          ) {
            for (const [key, value] of Object.entries(input)) {
              if (!declared.has(key)) {
                return Effect.fail(
                  new SchemaIssue.Pointer(
                    [key],
                    new SchemaIssue.UnexpectedKey(ast, value, options),
                  ),
                );
              }
            }
          }
          return SchemaParser.decodeUnknownEffect(codec)(input, options);
        },
      {
        // Generated as the struct it wraps, as the wire samples are
        // (test/wire.test.ts).
        toCodecArbitrary: ({ typeParameters: [codec] }) =>
          Schema.link<Schema.Struct<Fields>["Type"]>()(
            codec,
            SchemaTransformation.passthrough(),
          ),
        // Already JSON, as every contract schema's encoded side is
        // (codec.ts), so a JSON codec (the device link's) runs the key
        // check above on the wire's object as it is.
        toCodecJson: () => undefined,
      },
    ),
    { struct },
  );
}
