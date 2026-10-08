// The wire samples (fixtures/wire/v<PROTOCOL_VERSION>.json): one encoded
// payload and result per invoke, and one payload per push, for every
// call of every contract module. Each must decode with its schema and
// encode back to exactly itself, so a schema change that an older build
// could not read fails here, and is a protocol version bump.
//
// `pnpm -F @shigomori/contracts wire-fixtures` adds a sample derived
// from the schema for a call that has none and drops the samples of a
// call that is gone. It never rewrites a sample that is there.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import type { ContractSchema } from "../src/codec.ts";
import {
  callsOf,
  channelOf,
  type ContractModule,
  inputOf,
  isBroadcast,
  outputOf,
  payloadOf,
} from "../src/contract.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

type Sample = { payload?: unknown; success?: unknown };

const fill = process.env["UPDATE_WIRE_FIXTURES"] === "1";
const file = join(
  import.meta.dirname,
  `../fixtures/wire/v${PROTOCOL_VERSION}.json`,
);
let samples: Record<string, Sample> = existsSync(file)
  ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Sample>)
  : {};

// Every call, as its channel and the schemas its sample is read with.
const modulesDir = join(import.meta.dirname, "../src/modules");
const calls = new Map<string, Partial<Record<keyof Sample, ContractSchema>>>();
const modules = (await Promise.all(
  readdirSync(modulesDir).map((name) => import(join(modulesDir, name))),
)) as Record<string, unknown>[];
for (const module of modules) {
  for (const [exported, value] of Object.entries(module)) {
    if (!exported.endsWith("Contract")) continue;
    for (const call of callsOf(value as ContractModule)) {
      calls.set(
        channelOf(call),
        isBroadcast(call)
          ? { payload: payloadOf(call) }
          : { payload: inputOf(call), success: outputOf(call) },
      );
    }
  }
}

// A schema with nothing to send (a void payload or result) has no
// sample.
const isVoid = (schema: ContractSchema) =>
  Option.isSome(Schema.decodeUnknownOption(schema)(undefined));

const json = (value: unknown) => JSON.stringify(value);

// A sample derived from the schema: a small one when the schema's
// checks allow it, a default-sized one when they need more room.
async function derive(schema: ContractSchema, seed: string): Promise<unknown> {
  const sample = (size: number | undefined) =>
    Effect.runPromise(
      Arbitrary.sampleEffect(Arbitrary.schema(schema), {
        seed,
        count: 1,
        size,
      }),
    );
  const [value] = await sample(2).catch(() => sample(undefined));
  return Schema.encodeUnknownSync(schema)(value);
}

if (fill) {
  const underived: string[] = [];
  const derivedOrNoted = (schema: ContractSchema, at: string) =>
    derive(schema, at).catch(() => {
      underived.push(at);
      return undefined;
    });
  const entries = await Promise.all(
    [...calls]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(async ([channel, schemas]): Promise<[string, Sample]> => {
        const sample: Sample = { ...samples[channel] };
        const missing = (
          Object.entries(schemas) as [keyof Sample, ContractSchema][]
        ).filter(([part, schema]) => !isVoid(schema) && !(part in sample));
        const derived = await Promise.all(
          missing.map(([part, schema]) =>
            derivedOrNoted(schema, `${channel} ${part}`),
          ),
        );
        missing.forEach(([part], i) => {
          if (derived[i] !== undefined) sample[part] = derived[i];
        });
        return [channel, sample];
      }),
  );
  samples = Object.fromEntries(entries);
  writeFileSync(file, `${JSON.stringify(samples, null, 2)}\n`);
  if (underived.length > 0) {
    throw new Error(
      `no sample derives from the schema of these, so write them in ${file}:\n${underived.toSorted().join("\n")}`,
    );
  }
}

it(`every call has wire samples for protocol v${PROTOCOL_VERSION}, and every sample a call`, () => {
  assert.ok(existsSync(file), `${file} is missing`);
  assert.deepEqual(
    [...calls.keys()].filter((channel) => !(channel in samples)),
    [],
    "calls without samples: run pnpm -F @shigomori/contracts wire-fixtures",
  );
  assert.deepEqual(
    Object.keys(samples).filter((channel) => !calls.has(channel)),
    [],
    "samples of calls that are gone",
  );
});

describe.each([...calls])("%s", (channel, schemas) => {
  it("decodes its samples and encodes them back unchanged", () => {
    const sample = samples[channel] ?? {};
    for (const [part, schema] of Object.entries(schemas) as [
      keyof Sample,
      ContractSchema,
    ][]) {
      if (isVoid(schema)) {
        assert.ok(!(part in sample), `${part} is void but has a sample`);
        continue;
      }
      assert.ok(part in sample, `${part} has no sample`);
      const decoded = Schema.decodeUnknownSync(schema)(sample[part]);
      assert.equal(
        json(Schema.encodeUnknownSync(schema)(decoded)),
        json(sample[part]),
      );
    }
  });
});
