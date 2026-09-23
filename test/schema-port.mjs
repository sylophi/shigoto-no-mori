// Durable proof for the zod-to-Schema port (EFFECT-MIGRATION.md,
// Phase 4): every schema moved to Effect Schema decodes and refuses
// exactly what its zod version did. Pure: no sockets, no Electron.
//
// The expectations below are the zod versions' results, recorded by
// running them before the port. They are literal on purpose, so the
// proof outlives zod: a later edit that changes what a schema accepts
// has to change this table too.
//
// Asserts, through the wires' own decode (shared/ipc/codec.ts,
// decodeWith and safeDecodeWith, which must agree):
//   - each ported schema is a Schema, not zod, so the codec takes the
//     Schema path;
//   - valid inputs decode to the zod output: unknown keys stripped at
//     every level, an optional key absent stays absent and an explicit
//     undefined stays an own key, url input trimmed;
//   - invalid inputs are refused: wrong types, missing keys, empty
//     strings under a min length, ports out of range or fractional, an
//     enum value outside the set, a non-web URL (with the refine's
//     message);
//   - a void input decodes undefined and nothing else;
//   - strictStruct (shared/schemas/strict.ts) is z.strictObject: an
//     undeclared key at its level is refused with the key named, a
//     nested plain struct still strips, optional keys and the decoded
//     key set are Schema.Struct's, Schema.is refuses excess keys too,
//     and a `__proto__` key is refused rather than acted on (its types
//     are pinned by test/types/strict-struct.mts under pnpm typecheck);
//   - the v4 constructs the mapping relies on keep the semantics it
//     assumes (Void versus Undefined, Number versus Finite, the two
//     decoding defaults, excess keys stripped by default and refused
//     under onExcessProperty "error").
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test schema-port.
import assert from "node:assert/strict";
import { Effect, Schema, Struct } from "effect";
import { decodeWith, isZodCodec, safeDecodeWith } from "@shared/ipc/codec";
import { terrierContract } from "@shared/ipc/modules/terrier";
import {
  DirectoryListingSchema,
  PickFolderPayloadSchema,
  PortNumberSchema,
  ShellOpenExternalPayloadSchema,
  TerrierReadinessSchema,
  WorktreePortsResultSchema,
  parsePortNumber,
} from "@shared/schemas";
import { strictStruct } from "@shared/schemas/strict";
import { makeProof } from "./lib/checkKit.mjs";

const { check, done, fail } = makeProof("schema-port proof");

const ok = (value) => ({ ok: value });
// A refusal, optionally naming text the failure message must carry.
const refuse = (message) => ({ refuse: true, message });

function describe(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return JSON.stringify(value);
}

// One schema against its recorded zod results, through both codec calls.
function assertCases(codec, cases) {
  assert.equal(isZodCodec(codec), false, "the schema is still zod");
  for (const [input, want] of cases) {
    const label = describe(input);
    const safe = safeDecodeWith(codec, input);
    if (want.refuse) {
      assert.equal(safe.success, false, `${label} should be refused`);
      assert.throws(() => decodeWith(codec, input), `${label} should throw`);
      if (want.message !== undefined) {
        assert.match(
          String(safe.error?.message),
          new RegExp(want.message.replace(/[()]/g, "\\$&")),
          `${label} should be refused with "${want.message}"`,
        );
      }
      continue;
    }
    assert.equal(
      safe.success,
      true,
      `${label} should decode: ${safe.error?.message}`,
    );
    assert.deepStrictEqual(safe.data, want.ok, `${label} decoded output`);
    assert.deepStrictEqual(
      decodeWith(codec, input),
      want.ok,
      `${label} decodeWith output`,
    );
  }
}

const hasOwn = (value, key) => Object.hasOwn(value, key);

// A one-row port list.
const row = (fields) => ({ ports: [fields] });

// Whether a Schema decodes the input, for the construct checks.
const decodes = (schema, input, options) =>
  Schema.decodeUnknownExit(schema, options)(input)._tag === "Success";

async function main() {
  await check("PickFolderPayloadSchema matches zod", () => {
    const full = {
      title: "T",
      buttonLabel: "B",
      message: "M",
      defaultPath: "/x",
    };
    assertCases(PickFolderPayloadSchema, [
      // The whole payload is optional (zod's .optional() on the object).
      [undefined, ok(undefined)],
      [{}, ok({})],
      [full, ok(full)],
      [{ title: "T", extra: 1 }, ok({ title: "T" })],
      [{ title: undefined }, ok({ title: undefined })],
      [{ title: "" }, refuse()],
      [{ title: 1 }, refuse()],
      [null, refuse()],
      ["x", refuse()],
      [[], refuse()],
    ]);
    // Absent stays absent, explicit undefined stays an own key.
    assert.equal(
      hasOwn(decodeWith(PickFolderPayloadSchema, {}), "title"),
      false,
    );
    assert.equal(
      hasOwn(
        decodeWith(PickFolderPayloadSchema, { title: undefined }),
        "title",
      ),
      true,
    );
  });

  await check("DirectoryListingSchema matches zod", () => {
    assertCases(DirectoryListingSchema, [
      [{ path: "/a", entries: [] }, ok({ path: "/a", entries: [] })],
      [
        {
          path: "/a",
          entries: [{ name: "x", isGitRepo: true, junk: 1 }],
          extra: 2,
        },
        ok({ path: "/a", entries: [{ name: "x", isGitRepo: true }] }),
      ],
      [{ path: "/a" }, refuse()],
      [{ path: "/a", entries: [{ name: "x" }] }, refuse()],
      [{ path: "/a", entries: {} }, refuse()],
      [{ path: 1, entries: [] }, refuse()],
      [undefined, refuse()],
    ]);
  });

  await check("ShellOpenExternalPayloadSchema matches zod", () => {
    const WEB_ONLY = "Only http(s) URLs can be opened";
    assertCases(ShellOpenExternalPayloadSchema, [
      [{ url: "https://example.com" }, ok({ url: "https://example.com" })],
      [
        { url: "http://localhost:3000/x?y=1" },
        ok({ url: "http://localhost:3000/x?y=1" }),
      ],
      // zod's url check trimmed its output; the handler opens the trimmed URL.
      [{ url: "  https://example.com  " }, ok({ url: "https://example.com" })],
      [
        { url: "\thttps://example.com/\n" },
        ok({ url: "https://example.com/" }),
      ],
      [{ url: "http:example.com" }, ok({ url: "http:example.com" })],
      [{ url: "HTTPS://EXAMPLE.COM" }, ok({ url: "HTTPS://EXAMPLE.COM" })],
      [
        { url: "https://example.com", extra: 1 },
        ok({ url: "https://example.com" }),
      ],
      [{ url: "file:///etc/passwd" }, refuse(WEB_ONLY)],
      [{ url: "javascript:alert(1)" }, refuse(WEB_ONLY)],
      [{ url: "mailto:a@b.c" }, refuse(WEB_ONLY)],
      [{ url: "not a url" }, refuse()],
      [{ url: "" }, refuse()],
      [{ url: "http://" }, refuse()],
      [{}, refuse()],
      [{ url: 5 }, refuse()],
    ]);
  });

  await check("TerrierReadinessSchema matches zod", () => {
    assertCases(TerrierReadinessSchema, [
      [
        { installed: true, compatible: true, version: "0.4.1" },
        ok({ installed: true, compatible: true, version: "0.4.1" }),
      ],
      [
        { installed: false, compatible: false },
        ok({ installed: false, compatible: false }),
      ],
      [
        { installed: true, compatible: false, version: undefined },
        ok({ installed: true, compatible: false, version: undefined }),
      ],
      [
        { installed: true, compatible: true, extra: 1 },
        ok({ installed: true, compatible: true }),
      ],
      [{ installed: true, compatible: true, version: null }, refuse()],
      [{ installed: "yes", compatible: true }, refuse()],
      [{}, refuse()],
    ]);
    const absent = decodeWith(TerrierReadinessSchema, {
      installed: false,
      compatible: false,
    });
    assert.equal(
      hasOwn(absent, "version"),
      false,
      "absent version stays absent",
    );
  });

  await check("terrier:readiness's void input decodes undefined only", () => {
    assertCases(terrierContract.calls.readiness.input, [
      [undefined, ok(undefined)],
      [null, refuse()],
      [{}, refuse()],
      [0, refuse()],
      ["", refuse()],
    ]);
  });

  await check("WorktreePortsResultSchema matches zod", () => {
    assertCases(WorktreePortsResultSchema, [
      [{ ports: [] }, ok({ ports: [] })],
      [
        row({ port: 3000, label: "web", source: "pool", listening: true }),
        ok(row({ port: 3000, label: "web", source: "pool", listening: true })),
      ],
      [
        {
          ports: [{ port: 3000, source: "custom", listening: false, extra: 1 }],
          extra: 2,
        },
        ok(row({ port: 3000, source: "custom", listening: false })),
      ],
      [
        row({ port: 3000, label: "", source: "pool", listening: true }),
        ok(row({ port: 3000, label: "", source: "pool", listening: true })),
      ],
      [
        row({ port: 3000, label: undefined, source: "pool", listening: true }),
        ok(
          row({
            port: 3000,
            label: undefined,
            source: "pool",
            listening: true,
          }),
        ),
      ],
      [row({ port: 3000, source: "other", listening: true }), refuse()],
      [row({ port: 0, source: "pool", listening: true }), refuse()],
      [row({ port: 65536, source: "pool", listening: true }), refuse()],
      [row({ port: 3000.5, source: "pool", listening: true }), refuse()],
      [row({ port: Number.NaN, source: "pool", listening: true }), refuse()],
      [row({ port: Infinity, source: "pool", listening: true }), refuse()],
      [row({ port: "3000", source: "pool", listening: true }), refuse()],
      [{}, refuse()],
      [row({ port: 3000, source: "pool" }), refuse()],
    ]);
  });

  await check("parsePortNumber matches zod's PortNumberSchema", () => {
    const recorded = {
      3000: 3000,
      "": undefined,
      0: undefined,
      65536: undefined,
      "1e3": 1000,
      " 80 ": 80,
      "0x50": 80,
      abc: undefined,
      1.5: undefined,
      65535: 65535,
      1: 1,
      "-1": undefined,
      Infinity: undefined,
    };
    for (const [raw, want] of Object.entries(recorded)) {
      assert.equal(parsePortNumber(raw), want, `parsePortNumber(${raw})`);
      // The zod form still embedded by config.ts and the forward
      // contracts must agree with the Schema form while both exist.
      const viaZod = PortNumberSchema.safeParse(Number(raw));
      assert.equal(
        viaZod.success ? viaZod.data : undefined,
        want,
        `zod PortNumberSchema on ${raw}`,
      );
    }
  });

  await check("strictStruct refuses what z.strictObject refused", () => {
    const Strict = strictStruct({
      name: Schema.NonEmptyString,
      note: Schema.optional(Schema.String),
      inner: Schema.optional(Schema.Struct({ x: Schema.Number })),
    });
    // Recorded against z.strictObject({ name: z.string().min(1),
    // note: z.string().optional(), inner: z.object({ x: z.number() })
    // .optional() }), except the two rows marked below.
    assertCases(Strict, [
      [{ name: "n" }, ok({ name: "n" })],
      [{ name: "n", note: "m" }, ok({ name: "n", note: "m" })],
      [{ name: "n", note: undefined }, ok({ name: "n", note: undefined })],
      // Strict at its own level only: the nested plain struct strips.
      [
        { name: "n", inner: { x: 1, junk: 2 } },
        ok({ name: "n", inner: { x: 1 } }),
      ],
      [{ name: "n", socketHost: {} }, refuse('Unexpected key "socketHost"')],
      [
        { name: "n", note: "m", extra: undefined },
        refuse('Unexpected key "extra"'),
      ],
      [{ name: "" }, refuse()],
      [{ name: "n", note: 1 }, refuse()],
      [{ name: "n", inner: { x: "1" } }, refuse()],
      [{}, refuse()],
      [null, refuse()],
      [[], refuse()],
      ["x", refuse()],
      // zod skipped an own `__proto__` key (JSON.parse makes one) and
      // accepted; the strict struct refuses it.
      [
        JSON.parse('{"name":"n","__proto__":{"polluted":true}}'),
        refuse('Unexpected key "__proto__"'),
      ],
      // zod's for-in also refused an inherited enumerable key; only own
      // keys arrive over a wire, and the decoded value is a fresh object
      // with none of the prototype's keys.
      [
        Object.assign(Object.create({ inherited: 1 }), { name: "n" }),
        ok({ name: "n" }),
      ],
    ]);
    assert.equal({}.polluted, undefined, "Object.prototype untouched");

    // The refusal is the issue onExcessProperty "error" raises, at the
    // key's path, and names the key in the message.
    const refused = safeDecodeWith(Strict, { name: "n", socketHost: 1 });
    assert.equal(
      refused.error?.message,
      'Unexpected key "socketHost"\n  at ["socketHost"]',
    );
    // Every excess key under errors "all", the first one otherwise.
    const twoExtra = { name: "n", b: 1, a: 2 };
    assert.throws(
      () => Schema.decodeUnknownSync(Strict, { errors: "all" })(twoExtra),
      (error) =>
        error.message ===
        'Unexpected key "b"\n  at ["b"]\nUnexpected key "a"\n  at ["a"]',
    );
    assert.throws(
      () => decodeWith(Strict, twoExtra),
      (error) => error.message === 'Unexpected key "b"\n  at ["b"]',
    );

    // The decoded value carries exactly the declared keys it was given:
    // an absent optional stays absent, an explicit undefined stays own.
    assert.deepStrictEqual(
      Object.keys(decodeWith(Strict, { name: "n", inner: { x: 1 } })),
      ["name", "inner"],
    );
    assert.deepStrictEqual(Object.keys(decodeWith(Strict, { name: "n" })), [
      "name",
    ]);
    assert.deepStrictEqual(
      Object.keys(decodeWith(Strict, { name: "n", note: undefined })),
      ["name", "note"],
    );

    // Schema.is refuses an excess key too, so a guard cannot pass a
    // value that still carries it. It checks, it does not strip: a
    // nested plain struct's junk is fine.
    const isStrict = Schema.is(Strict);
    assert.equal(isStrict({ name: "n" }), true);
    assert.equal(isStrict({ name: "n", inner: { x: 1, junk: 2 } }), true);
    assert.equal(isStrict({ name: "n", socketHost: {} }), false);
    assert.equal(
      isStrict(JSON.parse('{"name":"n","__proto__":{"polluted":true}}')),
      false,
    );
    assert.equal(isStrict({ name: "" }), false);

    // Nested in a plain struct, the strict level still refuses (the path
    // runs through the outer key) and the outer level still strips.
    const Outer = Schema.Struct({ patch: Strict });
    assert.deepStrictEqual(
      decodeWith(Outer, { patch: { name: "n" }, junk: 1 }),
      { patch: { name: "n" } },
    );
    assert.equal(
      safeDecodeWith(Outer, { patch: { name: "n", socketHost: 1 } }).error
        ?.message,
      'Unexpected key "socketHost"\n  at ["patch"]["socketHost"]',
    );
    // A union of strict members keeps its literal discrimination.
    const Tagged = Schema.Union([
      strictStruct({ kind: Schema.Literal("a"), x: Schema.String }),
      strictStruct({ kind: Schema.Literal("b"), y: Schema.String }),
    ]);
    assert.deepStrictEqual(decodeWith(Tagged, { kind: "b", y: "1" }), {
      kind: "b",
      y: "1",
    });
    assert.equal(
      safeDecodeWith(Tagged, { kind: "b", y: "1", x: "1" }).success,
      false,
    );

    // Defaults and field checks behave as in Schema.Struct.
    const Defaulted = strictStruct({
      mode: Schema.String.pipe(
        Schema.optional,
        Schema.withDecodingDefault(Effect.succeed("d")),
      ),
      url: ShellOpenExternalPayloadSchema.fields.url,
    });
    assert.deepStrictEqual(decodeWith(Defaulted, { url: " https://a.b " }), {
      mode: "d",
      url: "https://a.b",
    });
    assert.equal(
      safeDecodeWith(Defaulted, { url: "file:///x" }).success,
      false,
    );

    // `fields` is the input, and survives a rebuild; the strictness
    // survives an annotation.
    const annotated = Strict.annotate({ title: "Strict" });
    assert.equal(annotated.fields, Strict.fields);
    assert.equal(safeDecodeWith(annotated, { name: "n", b: 1 }).success, false);

    // The pick recipe (z.strictObject(X.pick({...}).shape)): pick the
    // fields, then make them strict. An unpicked key is refused.
    const Base = Schema.Struct({
      keep: Schema.optional(Schema.Boolean),
      secret: Schema.optional(Schema.String),
    });
    const Patch = strictStruct(Struct.pick(Base.fields, ["keep"]));
    assert.deepStrictEqual(decodeWith(Patch, { keep: true }), { keep: true });
    assert.throws(
      () => decodeWith(Patch, { keep: true, secret: "t" }),
      /Unexpected key "secret"/,
    );
  });

  await check(
    "the v4 constructs keep the semantics the mapping assumes",
    () => {
      // z.void() refuses a present value; Schema.Void discards it, so the
      // port uses Schema.Undefined.
      assert.equal(
        decodes(Schema.Void, {}),
        true,
        "Void accepts a present value",
      );
      assert.equal(decodes(Schema.Undefined, {}), false);
      assert.equal(decodes(Schema.Undefined, undefined), true);
      // zod 4's z.number() refuses NaN and the infinities; Schema.Number
      // takes them, Schema.Finite does not. Schema.Int refuses them too.
      for (const n of [Number.NaN, Infinity, -Infinity]) {
        assert.equal(decodes(Schema.Number, n), true, `Number takes ${n}`);
        assert.equal(decodes(Schema.Finite, n), false, `Finite refuses ${n}`);
        assert.equal(decodes(Schema.Int, n), false, `Int refuses ${n}`);
      }
      // z.object strips unknown keys; so does a Struct under the default
      // parse options, and onExcessProperty "error" is z.strictObject.
      const struct = Schema.Struct({ a: Schema.String });
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(struct)({ a: "x", b: 1 }),
        { a: "x" },
      );
      assert.equal(
        decodes(struct, { a: "x", b: 1 }, { onExcessProperty: "error" }),
        false,
      );
      // zod's .default(x) fills an absent key and an explicit undefined:
      // withDecodingDefault does both, withDecodingDefaultKey only the
      // absent key.
      const withDefault = Schema.Struct({
        a: Schema.String.pipe(
          Schema.optional,
          Schema.withDecodingDefault(Effect.succeed("d")),
        ),
      });
      const withKeyDefault = Schema.Struct({
        a: Schema.String.pipe(
          Schema.optionalKey,
          Schema.withDecodingDefaultKey(Effect.succeed("d")),
        ),
      });
      const decode = Schema.decodeUnknownSync;
      assert.deepStrictEqual(decode(withDefault)({}), { a: "d" });
      assert.deepStrictEqual(decode(withDefault)({ a: undefined }), { a: "d" });
      assert.deepStrictEqual(decode(withDefault)({ a: "x" }), { a: "x" });
      assert.equal(decodes(withDefault, { a: null }), false);
      assert.deepStrictEqual(decode(withKeyDefault)({}), { a: "d" });
      assert.equal(decodes(withKeyDefault, { a: undefined }), false);
      // .optional() on a key is Schema.optional (absent or undefined);
      // Schema.optionalKey refuses an explicit undefined.
      const optionalKey = Schema.Struct({
        a: Schema.optionalKey(Schema.String),
      });
      assert.equal(decodes(optionalKey, {}), true);
      assert.equal(decodes(optionalKey, { a: undefined }), false);
      // z.string().trim().min(1).max(n): Schema.Trim trims before its checks.
      const trimmed = Schema.Trim.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(3),
      );
      assert.equal(decode(trimmed)("  abc  "), "abc");
      assert.equal(decodes(trimmed, "   "), false);
      assert.equal(decodes(trimmed, " abcd "), false);
    },
  );

  done();
}

main().catch(fail);
