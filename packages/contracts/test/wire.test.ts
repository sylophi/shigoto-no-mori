// The wire samples (README.md, "Wire samples"): every call of every
// contract module has an encoded sample of each part it sends, in the
// file of its module's version, and each sample still decodes and goes
// back to exactly itself.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as SchemaBinary from "effect/encoding/SchemaBinary";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import {
  callsOf,
  channelOf,
  type ContractCall,
  type ContractModule,
  type ContractSchema,
  inputOf,
  isPush,
  isInvoke,
  moduleOf,
  outputOf,
  payloadOf,
  versionOf,
} from "../src/contract.ts";
import { VoidSchema } from "../src/schemas/void.ts";
import { json, wireForms } from "./wireForms.ts";

type Part = "payload" | "success";
type Sample = Partial<Record<Part, unknown>>;

const dir = join(import.meta.dirname, "../fixtures/wire");

// A versioned module's samples are held to its version by their file's
// name. The calls only one build's own processes exchange share a file
// that is edited in place.
const LOCAL = "local.json";
const fileOf = (call: ContractCall) => {
  const version = versionOf(call);
  return version === undefined ? LOCAL : `${moduleOf(call)}.v${version}.json`;
};

// A part with nothing to send has no sample.
const isVoid = (schema: ContractSchema) =>
  schema === VoidSchema || schema === Schema.Void;

// Every call of every module, as its channel and the parts it sends.
const modulesDir = join(import.meta.dirname, "../src/modules");
const modules = (await Promise.all(
  readdirSync(modulesDir).map((name) => import(join(modulesDir, name))),
)) as Record<string, unknown>[];
const calls = new Map<string, [Part, ContractSchema][]>();
// The samples file each call's are in, and each file's channels.
const fileOfChannel = new Map<string, string>();
const files = new Map<string, string[]>();
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
      const file = fileOf(call);
      fileOfChannel.set(channel, file);
      files.set(file, [...(files.get(file) ?? []), channel]);
      const parts: [Part, ContractSchema][] = isPush(call)
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

const read = (name: string) =>
  JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, Sample>;
const present = readdirSync(dir);
// A version with no samples file whose module has one under another
// version: a bump whose file was not moved yet.
const moduleOfFile = (name: string) => name.slice(0, name.indexOf("."));
const unmoved = [...files.keys()].filter(
  (name) =>
    !present.includes(name) &&
    present.some(
      (other) =>
        !files.has(other) && moduleOfFile(other) === moduleOfFile(name),
    ),
);
// By the file each is in, so a sample in another module's file counts
// as that file's stray, not as its call's.
let samples = new Map(
  present.map((name): [string, Record<string, Sample>] => [name, read(name)]),
);
const sampleOf = (channel: string) =>
  samples.get(fileOfChannel.get(channel) ?? "")?.[channel];

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

// A bumped module's file is never written here: the bump moves the
// last version's file to the new name first, so the samples that still
// read are kept and the diff is the ones that don't.
if (process.env["UPDATE_WIRE_FIXTURES"] === "1" && unmoved.length === 0) {
  const underived: string[] = [];
  const written = await Promise.all(
    [...files].map(
      async ([name, channels]): Promise<[string, Record<string, Sample>]> => {
        const entries = await Promise.all(
          channels
            .toSorted((a, b) => a.localeCompare(b))
            .map(async (channel): Promise<[string, Sample]> => {
              const kept = samples.get(name)?.[channel] ?? {};
              const sample: Sample = {};
              await Promise.all(
                (calls.get(channel) ?? []).map(async ([part, schema]) => {
                  if (part in kept) {
                    sample[part] = kept[part];
                    return;
                  }
                  await derive(schema, `${channel}.${part}`).then(
                    (value) => {
                      sample[part] = value;
                    },
                    () => underived.push(`${name}: ${channel} ${part}`),
                  );
                }),
              );
              return [channel, sample];
            }),
        );
        return [name, Object.fromEntries(entries)];
      },
    ),
  );
  samples = new Map(written);
  for (const [name, content] of samples) {
    writeFileSync(join(dir, name), `${JSON.stringify(content, null, 2)}\n`);
  }
  if (underived.length > 0) {
    throw new Error(
      `no sample derives from the schema of these, so write them in ${dir}:\n${underived.toSorted().join("\n")}`,
    );
  }
}

it("every module's version has its samples file, and every file a version", () => {
  assert.deepEqual(
    unmoved,
    [],
    "bumped versions without a samples file: git mv the module's last file to this name, then run pnpm -F @shigomori/contracts wire-fixtures",
  );
  assert.deepEqual(
    [...files.keys()].filter((name) => !samples.has(name)),
    [],
    "versions without a samples file: run pnpm -F @shigomori/contracts wire-fixtures",
  );
  assert.deepEqual(
    present.filter((name) => !files.has(name)),
    [],
    "samples files no module's version names",
  );
});

it("every call has wire samples, and every sample a call", () => {
  for (const [name, channels] of files) {
    const held = samples.get(name) ?? {};
    assert.deepEqual(
      channels.filter((channel) => !(channel in held)),
      [],
      `calls without samples in ${name}: run pnpm -F @shigomori/contracts wire-fixtures`,
    );
    assert.deepEqual(
      Object.keys(held).filter((channel) => !channels.includes(channel)),
      [],
      `samples in ${name} of calls that are gone: run pnpm -F @shigomori/contracts wire-fixtures`,
    );
  }
});

// JSON.parse keeps the last of two samples under one channel, so a
// duplicate would hide one of them from every check above.
it("names each call once in its samples file", () => {
  for (const name of present) {
    const channels = [
      ...readFileSync(join(dir, name), "utf8").matchAll(/^ {2}"([^"]+)":/gm),
    ].map(([, channel]) => channel);
    assert.deepEqual(
      channels.filter((channel, i) => channels.indexOf(channel) !== i),
      [],
      name,
    );
  }
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
    const sample = sampleOf(channel) ?? {};
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
