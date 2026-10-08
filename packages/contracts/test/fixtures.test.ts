// Holds the JSON the schemas read and write to the golden fixtures in
// fixtures/, one file per schema family.
// The Go CLI shares these shapes on disk and the hub and web client on
// the wire, so a schema's rewrite must keep the JSON it accepts,
// produces and refuses exactly as it is.
//
// Each schema exported from the schemas barrel or the hub protocol, and
// the contract errors' wire form, has an entry:
//   accepts     values that decode to themselves, key order included
//   normalizes  { input, output } pairs where decoding changes the value
//               (a default filled in, an unknown key dropped)
//   rejects     values that must fail to decode
//
// Each schema must also encode its decoded value
// back to the same JSON, and the decoded value itself must serialize
// to it, since the wires send decoded values as they are.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import { json, wireForms } from "./wireForms.ts";
import { ContractErrorSchema } from "../src/errors.ts";
import * as hubProtocol from "../src/hubProtocol.ts";
import * as schemas from "../src/schemas/index.ts";

type Fixture = {
  accepts?: unknown[];
  normalizes?: { input: unknown; output: unknown }[];
  rejects?: unknown[];
};

const dir = join(import.meta.dirname, "../fixtures");
const fixtures = new Map<string, Fixture>();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const entries = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<
    string,
    Fixture
  >;
  for (const [name, fixture] of Object.entries(entries)) {
    assert.ok(!fixtures.has(name), `${name} has fixtures in two files`);
    fixtures.set(name, fixture);
  }
}

const exported = Object.entries({
  ...schemas,
  ...hubProtocol,
  ContractErrorSchema,
}).filter(([name]) => name.endsWith("Schema")) as [
  string,
  Schema.Codec<unknown, unknown>,
][];

it("every exported schema has fixtures, and every fixture a schema", () => {
  const names = new Set(exported.map(([name]) => name));
  assert.deepEqual(
    exported.map(([name]) => name).filter((name) => !fixtures.has(name)),
    [],
  );
  assert.deepEqual(
    [...fixtures.keys()].filter((name) => !names.has(name)),
    [],
  );
});

function refuses(
  schema: Schema.Codec<unknown, unknown>,
  value: unknown,
): boolean {
  return Option.isNone(Schema.decodeUnknownOption(schema)(value));
}

describe.each(exported)("%s", (name, schema) => {
  const fixture = fixtures.get(name) ?? {};

  it("accepts its samples unchanged", () => {
    for (const value of fixture.accepts ?? []) {
      for (const form of wireForms(schema, value)) {
        assert.equal(form, json(value));
      }
    }
  });

  it("normalizes its inputs to their outputs", () => {
    for (const { input, output } of fixture.normalizes ?? []) {
      for (const form of wireForms(schema, input)) {
        assert.equal(form, json(output));
      }
    }
  });

  it("rejects its invalid samples", () => {
    for (const value of fixture.rejects ?? []) {
      assert.ok(refuses(schema, value), json(value));
    }
  });
});
