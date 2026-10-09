// Properties over generated values: `holds` checks one, and `textOf`
// builds strings from the pieces an input is made of, so generated text
// hits the characters a parser cares about.
import assert from "node:assert/strict";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// A property that holds for every generated value, or the shrunk input
// that broke it.
export const holds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean,
  runs = 1000,
) => {
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(arbitrary, property, { runs }),
  );
  assert.equal(Arbitrary.formatCheckFailure(result), undefined);
};

export const textOf = (
  pieces: readonly [string, ...string[]],
  length: { readonly minLength?: number; readonly maxLength: number },
) =>
  Arbitrary.map(
    Arbitrary.array(Arbitrary.schema(Schema.Literals(pieces)), length),
    (parts) => parts.join(""),
  );
