// Type-level proof for shared/schemas/strict.ts, pinned by
// `pnpm typecheck` (tsconfig includes test/**/*.mts). Not a runnable
// proof: it sits below test/ so `pnpm test` does not list it. The
// runtime half is test/schema-port.mjs.
//
// strictStruct(fields) must type exactly as Schema.Struct(fields) on
// both sides, so a consumer (a contract, a handler's payload) cannot
// tell the two apart, and must keep `fields` for the pick recipe.
import { Effect, Schema, Struct } from "effect";
import { strictStruct } from "@shared/schemas/strict";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assertType = <T extends true>(): T => true as T;

const fields = {
  required: Schema.String,
  optional: Schema.optional(Schema.Number),
  optionalKey: Schema.optionalKey(Schema.Boolean),
  trimmed: Schema.Trim,
  defaulted: Schema.String.pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed("d")),
  ),
  nested: Schema.Struct({ x: Schema.Number }),
  list: Schema.Array(Schema.Literals(["a", "b"])),
  // Type number, Encoded string: the two sides differ, so the Encoded
  // assertion below is not the Type one again.
  parsed: Schema.NumberFromString,
};
const strict = strictStruct(fields);
const plain = Schema.Struct(fields);

assertType<Equals<typeof strict.Type, typeof plain.Type>>();
assertType<Equals<typeof strict.Encoded, typeof plain.Encoded>>();
assertType<Equals<typeof strict.fields, typeof plain.fields>>();
assertType<Equals<Equals<typeof strict.Type, typeof strict.Encoded>, false>>();
assertType<
  Equals<typeof strict.DecodingServices, typeof plain.DecodingServices>
>();
// A rebuild (annotate, check) keeps the strict interface and its fields.
assertType<
  Equals<ReturnType<typeof strict.annotate>["Type"], typeof plain.Type>
>();
assertType<
  Equals<ReturnType<typeof strict.annotate>["fields"], typeof fields>
>();

// Nested in a plain struct and made optional, it types as the plain one.
const outer = Schema.Struct({ patch: Schema.optional(strict) });
const outerPlain = Schema.Struct({ patch: Schema.optional(plain) });
assertType<Equals<typeof outer.Type, typeof outerPlain.Type>>();
assertType<Equals<typeof outer.Encoded, typeof outerPlain.Encoded>>();

// The pick recipe: pick the fields, then make them strict.
const picked = strictStruct(Struct.pick(plain.fields, ["required", "nested"]));
const pickedPlain = Schema.Struct(
  Struct.pick(plain.fields, ["required", "nested"]),
);
assertType<Equals<typeof picked.Type, typeof pickedPlain.Type>>();
assertType<
  Equals<
    typeof picked.Type,
    { readonly required: string; readonly nested: { readonly x: number } }
  >
>();
