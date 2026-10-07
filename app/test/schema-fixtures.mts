// Holds the JSON the shared schemas read and write to the golden
// fixtures in packages/contracts/fixtures, one file per schema family.
// The Go CLI shares these shapes on disk and the hub and web client on
// the wire, so a schema's rewrite must keep the JSON it accepts,
// produces and refuses exactly as it is.
//
// Each schema exported from @shared/schemas has an entry:
//   accepts     values that parse to themselves, key order included
//   normalizes  { input, output } pairs where parsing changes the value
//               (a default filled in, an unknown key dropped)
//   rejects     values that must fail to parse
//
// covers: packages/contracts/fixtures/**
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { z } from "zod";
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

const exported = Object.entries(schemas).filter(([name]) =>
  name.endsWith("Schema"),
) as [string, z.ZodType][];

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

describe.each(exported)("%s", (name, schema) => {
  const fixture = fixtures.get(name) ?? {};

  it("accepts its samples unchanged", () => {
    for (const value of fixture.accepts ?? []) {
      assert.equal(json(schema.parse(value)), json(value));
    }
  });

  it("normalizes its inputs to their outputs", () => {
    for (const { input, output } of fixture.normalizes ?? []) {
      assert.equal(json(schema.parse(input)), json(output));
    }
  });

  it("rejects its invalid samples", () => {
    for (const value of fixture.rejects ?? []) {
      assert.equal(schema.safeParse(value).success, false, json(value));
    }
  });
});
