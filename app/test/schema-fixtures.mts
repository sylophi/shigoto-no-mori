// Holds the JSON the shared schemas read and write to the golden
// fixtures in packages/contracts/fixtures, one file per schema family.
// The Go CLI shares these shapes on disk and the hub and web client on
// the wire, so a schema's rewrite must keep the JSON it accepts,
// produces and refuses exactly as it is.
//
// Each schema exported from @shared/schemas or the hub protocol has an
// entry:
//   accepts     values that decode to themselves, key order included
//   normalizes  { input, output } pairs where decoding changes the value
//               (a default filled in, an unknown key dropped)
//   rejects     values that must fail to decode
//
// A schema already on Effect Schema must also encode its decoded value
// back to the same JSON, and the decoded value itself must serialize
// to it, since the wires send decoded values as they are.
//
// covers: packages/contracts/fixtures/**
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import type { z } from "zod";
import * as hubProtocol from "@shared/hub/protocol";
import * as schemas from "@shared/schemas";

type Fixture = {
  accepts?: unknown[];
  normalizes?: { input: unknown; output: unknown }[];
  rejects?: unknown[];
};

const dir = join(import.meta.dirname, "../../packages/contracts/fixtures");
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

const exported = Object.entries({ ...schemas, ...hubProtocol }).filter(
  ([name]) => name.endsWith("Schema"),
) as [string, z.ZodType | Schema.Codec<unknown, unknown>][];

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

const json = (value: unknown) => JSON.stringify(value);

// The JSON forms a value takes on its way through the schema: the
// decoded value, and for an Effect schema its encoding as well.
function wireForms(
  schema: z.ZodType | Schema.Codec<unknown, unknown>,
  value: unknown,
): string[] {
  if (!Schema.isSchema(schema)) return [json(schema.parse(value))];
  const decoded = Schema.decodeUnknownSync(schema)(value);
  return [json(decoded), json(Schema.encodeSync(schema)(decoded))];
}

function refuses(
  schema: z.ZodType | Schema.Codec<unknown, unknown>,
  value: unknown,
): boolean {
  return Schema.isSchema(schema)
    ? Option.isNone(Schema.decodeUnknownOption(schema)(value))
    : !schema.safeParse(value).success;
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
