// The wire samples (README.md, "Wire samples"): every call of every
// contract module has an encoded sample of each part it sends, and each
// sample still decodes and goes back to exactly itself.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as SchemaBinary from "effect/encoding/SchemaBinary";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import type { ContractSchema } from "../src/codec.ts";
import {
  callsOf,
  channelOf,
  type ContractCall,
  type ContractModule,
  inputOf,
  isBroadcast,
  isInvoke,
  outputOf,
  payloadOf,
} from "../src/contract.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { VoidSchema } from "../src/schemas/void.ts";
import { json, wireForms } from "./wireForms.ts";

type Part = "payload" | "success";
type Sample = Partial<Record<Part, unknown>>;

const file = join(
  import.meta.dirname,
  `../fixtures/wire/v${PROTOCOL_VERSION}.json`,
);

// A part with nothing to send has no sample.
const isVoid = (schema: ContractSchema) =>
  schema === VoidSchema || schema === Schema.Void;

// Every call of every module, as its channel and the parts it sends.
const modulesDir = join(import.meta.dirname, "../src/modules");
const modules = (await Promise.all(
  readdirSync(modulesDir).map((name) => import(join(modulesDir, name))),
)) as Record<string, unknown>[];
const calls = new Map<string, [Part, ContractSchema][]>();
// The whole of each call as the device link carries it, for the binary
// layout check below.
const rpcs: ContractCall[] = [];
for (const module of modules) {
  for (const [exported, value] of Object.entries(module)) {
    if (!exported.endsWith("Contract")) continue;
    for (const call of callsOf(value as ContractModule)) {
      const channel = channelOf(call);
      assert.ok(!calls.has(channel), `${channel} is defined twice`);
      rpcs.push(call);
      const parts: [Part, ContractSchema][] = isBroadcast(call)
        ? [["payload", payloadOf(call)]]
        : [
            ["payload", inputOf(call)],
            ["success", isInvoke(call) ? outputOf(call) : payloadOf(call)],
          ];
      calls.set(
        channel,
        parts.filter(([, schema]) => !isVoid(schema)),
      );
    }
  }
}

let samples: Record<string, Sample> = existsSync(file)
  ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Sample>)
  : {};

// `pnpm -F @shigomori/contracts wire-fixtures`: a sample derived from
// the schema for each part that has none, small when the schema's
// checks allow it and never one that sends nothing, and the samples of
// calls and parts that are gone dropped. A sample that is there stays.
async function derive(schema: ContractSchema, seed: string): Promise<unknown> {
  const sample = (at: string, size: number | undefined) =>
    Effect.runPromise(
      Arbitrary.sampleEffect(Arbitrary.schema(schema), {
        seed: at,
        count: 1,
        size,
      }),
    ).then(([value]) => Schema.encodeUnknownSync(schema)(value));
  // A schema that may send nothing can derive nothing, so a few seeds
  // are tried for one that sends something.
  const attempt = async (n: number): Promise<unknown> => {
    if (n === 8) throw new Error(`${seed}: every sample derived sends nothing`);
    const at = `${seed}#${n}`;
    const encoded = await sample(at, 2).catch(() => sample(at, undefined));
    return encoded === undefined ? attempt(n + 1) : encoded;
  };
  return attempt(0);
}

if (process.env["UPDATE_WIRE_FIXTURES"] === "1") {
  const underived: string[] = [];
  const entries = await Promise.all(
    [...calls]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(async ([channel, parts]): Promise<[string, Sample]> => {
        const kept = samples[channel] ?? {};
        const sample: Sample = {};
        await Promise.all(
          parts.map(async ([part, schema]) => {
            if (part in kept) {
              sample[part] = kept[part];
              return;
            }
            await derive(schema, `${channel}.${part}`).then(
              (value) => {
                sample[part] = value;
              },
              () => underived.push(`${channel} ${part}`),
            );
          }),
        );
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
    "samples of calls that are gone: run pnpm -F @shigomori/contracts wire-fixtures",
  );
});

// The device link writes every call in Effect's binary layout, which
// refuses some schemas a JSON codec takes (a union of members it cannot
// tell apart). Compiled here, every part and every outcome, so such a
// schema fails this proof instead of its call.
it("every call's payload and outcome have a binary layout", () => {
  for (const call of rpcs) {
    assert.doesNotThrow(
      () => SchemaBinary.toCodec(call.payloadSchema),
      `${channelOf(call)}'s payload`,
    );
    assert.doesNotThrow(
      () => SchemaBinary.toCodec(Rpc.exitSchema(call)),
      `${channelOf(call)}'s outcome`,
    );
    if (!isInvoke(call)) {
      assert.doesNotThrow(
        () => SchemaBinary.toCodec(payloadOf(call)),
        `${channelOf(call)}'s values`,
      );
    }
  }
});

// A peer's answer crosses from the host to its window as the hop's own
// (hub:invokePeer), where a void call answers undefined.
it("the hub hop carries a void call's answer", () => {
  const invokePeer = rpcs.find((call) => channelOf(call) === "hub:invokePeer");
  assert.ok(invokePeer !== undefined && isInvoke(invokePeer));
  const codec = SchemaBinary.toCodec(outputOf(invokePeer));
  for (const answer of [undefined, null, { terminalId: "t" }]) {
    assert.deepEqual(
      Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(answer)),
      answer,
    );
  }
});

describe.each([...calls])("%s", (channel, parts) => {
  it("reads its samples back unchanged, decoded and encoded", () => {
    const sample = samples[channel] ?? {};
    assert.deepEqual(
      Object.keys(sample).toSorted(),
      parts.map(([part]) => part).toSorted(),
      "the parts sampled are not the parts the call sends",
    );
    for (const [part, schema] of parts) {
      const bridged = !channel.startsWith("link:");
      for (const form of wireForms(schema, sample[part], { bridged })) {
        assert.equal(form, json(sample[part]), part);
      }
    }
  });
});
