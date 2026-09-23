// Durable proof for the typed-error wire codec (shared/ipc/wireError.ts)
// and the matchers it feeds (shared/errors.ts, isCommandRefusedError in
// shared/ipc/socket/frames.ts). Pure: no sockets, no Electron.
//
// Asserts:
//   - encodeWireError of each tagged error carries `_tag`, the message
//     getter's text and the JSON fields, and nothing else (no stack,
//     name or cause). A plain Error encodes to undefined. A field that
//     is not JSON-safe is dropped.
//   - new WireError(shape) is an Error named by its tag, with the
//     fields as own enumerable properties, and every matcher reads it
//     the way it reads the original.
//   - a hostile shape (__proto__, constructor, prototype, name, stack)
//     cannot pollute or rename the instance.
//   - re-encoding a WireError (a hop) yields the same shape.
//   - WireErrorShapeSchema needs a non-empty `_tag` and a message and
//     keeps a newer peer's extra fields. The res frame schema carries
//     the `error` field and still reads an old peer's res without one.
//   - the tag wins over the message text, and a message-only Error from
//     an older peer still matches.
//   - settleEnvelope / unwrapEnvelope, the Electron wire's envelope,
//     round-trip a value, a tagged failure and a plain one.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test wire-error.
import assert from "node:assert/strict";
import { Schema } from "effect";
import {
  BranchNotMerged,
  NoDirectConnection,
  UnknownProject,
  UnknownWorktree,
  branchNotMergedError,
  errorFieldOf,
  errorTagOf,
  isBranchNotMergedError,
  isEntityGoneError,
  isNoDirectConnectionError,
  unknownProjectError,
  unknownWorktreeError,
} from "@shared/errors";
import {
  MAX_WIRE_FIELD_CHARS,
  WireError,
  WireErrorShapeSchema,
  encodeWireError,
  settleEnvelope,
  unwrapEnvelope,
} from "@shared/ipc/wireError";
import {
  COMMAND_REFUSED_MESSAGE,
  COMMAND_REFUSED_TAG,
  CommandRefusedError,
  ServerFrameSchema,
  isCommandRefusedError,
} from "@shared/ipc/socket/frames";
import { makeProof } from "./lib/checkKit.mjs";

const { check, done, fail } = makeProof("wire-error proof");

// Each typed error with the shape it must encode to and the one matcher
// that must claim it. The other matchers must not.
const MATCHERS = {
  isEntityGoneError,
  isNoDirectConnectionError,
  isBranchNotMergedError,
  isCommandRefusedError,
};
const CASES = [
  {
    error: unknownProjectError("p1"),
    shape: {
      _tag: "UnknownProject",
      projectId: "p1",
      message: "Unknown project: p1",
    },
    matcher: "isEntityGoneError",
  },
  {
    error: unknownWorktreeError("w1"),
    shape: {
      _tag: "UnknownWorktree",
      worktreeId: "w1",
      message: "Unknown worktree: w1",
    },
    matcher: "isEntityGoneError",
  },
  {
    error: new NoDirectConnection({ deviceId: "d1", reason: "keeper parked" }),
    shape: {
      _tag: "NoDirectConnection",
      deviceId: "d1",
      reason: "keeper parked",
      message: "no direct connection to d1 (keeper parked)",
    },
    matcher: "isNoDirectConnectionError",
  },
  {
    // A null field is JSON, so it rides.
    error: new NoDirectConnection({ deviceId: "d2", reason: null }),
    shape: {
      _tag: "NoDirectConnection",
      deviceId: "d2",
      reason: null,
      message: "no direct connection to d2",
    },
    matcher: "isNoDirectConnectionError",
  },
  {
    error: branchNotMergedError("feat"),
    shape: {
      _tag: "BranchNotMerged",
      branch: "feat",
      message: "Branch 'feat' has unmerged commits.",
    },
    matcher: "isBranchNotMergedError",
  },
  {
    // Not an Effect class: a plain Error subclass with a `_tag` field
    // and an own `name`, which must not ride.
    error: new CommandRefusedError({ message: COMMAND_REFUSED_MESSAGE }),
    shape: { _tag: COMMAND_REFUSED_TAG, message: COMMAND_REFUSED_MESSAGE },
    matcher: "isCommandRefusedError",
  },
];

function assertMatchers(error, want, label) {
  for (const [name, matcher] of Object.entries(MATCHERS)) {
    assert.equal(
      matcher(error),
      name === want,
      `${name} on ${label} should be ${name === want}`,
    );
  }
}

const decodeShape = Schema.decodeUnknownSync(WireErrorShapeSchema);
const decodeServerFrame = Schema.decodeUnknownSync(ServerFrameSchema);

// A shape WireErrorShapeSchema must refuse, and why.
function refuses(value, why) {
  assert.equal(Schema.is(WireErrorShapeSchema)(value), false, why);
}

// A typed error of some other tag whose message carries a matcher's
// legacy text.
function imposter(message) {
  return new WireError({ _tag: "Other", message });
}

async function main() {
  console.log("wire-error proof\n");

  await check(
    "encode: each tagged error carries _tag, the message getter's text and its JSON fields, and nothing else",
    () => {
      for (const { error, shape } of CASES) {
        assert.ok(error instanceof Error, `${shape._tag} is an Error`);
        assert.equal(error.message, shape.message);
        assert.deepEqual(encodeWireError(error), shape);
      }
      // The classes themselves, not only the helper constructors.
      assert.deepEqual(
        encodeWireError(new UnknownWorktree({ worktreeId: "w9" })),
        {
          _tag: "UnknownWorktree",
          worktreeId: "w9",
          message: "Unknown worktree: w9",
        },
      );
      // Reserved keys an error owns for itself never ride, even when a
      // tagged error carries them as own enumerable properties.
      const loaded = Object.assign(new Error("loaded"), {
        _tag: "Loaded",
        name: "Renamed",
        stack: "fake stack",
        cause: new Error("inner"),
        kept: 1,
      });
      assert.deepEqual(encodeWireError(loaded), {
        _tag: "Loaded",
        message: "loaded",
        kept: 1,
      });
    },
  );

  await check(
    "encode: a plain Error, or anything without a string _tag, encodes to undefined",
    () => {
      assert.equal(encodeWireError(new Error("boom")), undefined);
      assert.equal(encodeWireError("boom"), undefined);
      assert.equal(encodeWireError(null), undefined);
      assert.equal(encodeWireError(undefined), undefined);
      assert.equal(
        encodeWireError(Object.assign(new Error("x"), { _tag: 7 })),
        undefined,
      );
    },
  );

  await check(
    "encode: a field that is not JSON-safe is dropped while the JSON ones ride",
    () => {
      class Odd extends Schema.TaggedError()("Odd", {
        when: Schema.Date,
        count: Schema.Number,
        fn: Schema.Unknown,
        map: Schema.Unknown,
        nested: Schema.Unknown,
        deepBad: Schema.Unknown,
      }) {
        get message() {
          return `odd ${this.count}`;
        }
      }
      const odd = new Odd({
        when: new Date(0),
        count: Number.NaN,
        fn: () => 1,
        map: new Map([["a", 1]]),
        nested: { list: [1, "two", null, true], inner: { k: "v" } },
        deepBad: { list: [1, () => 2] },
      });
      assert.deepEqual(encodeWireError(odd), {
        _tag: "Odd",
        message: "odd NaN",
        nested: { list: [1, "two", null, true], inner: { k: "v" } },
      });
    },
  );

  await check(
    "rebuild: new WireError(shape) is an Error named by its tag, carrying the message and the fields as own enumerable properties",
    () => {
      for (const { shape } of CASES) {
        const rebuilt = new WireError(shape);
        assert.ok(rebuilt instanceof Error);
        assert.ok(rebuilt instanceof WireError);
        assert.equal(rebuilt.name, shape._tag);
        assert.equal(rebuilt._tag, shape._tag);
        assert.equal(rebuilt.message, shape.message);
        assert.equal(errorTagOf(rebuilt), shape._tag);
        for (const [key, value] of Object.entries(shape)) {
          if (key === "_tag" || key === "message") continue;
          const descriptor = Object.getOwnPropertyDescriptor(rebuilt, key);
          assert.ok(descriptor, `${key} is not an own property`);
          assert.equal(descriptor.enumerable, true, `${key} not enumerable`);
          assert.deepEqual(descriptor.value, value);
          assert.deepEqual(errorFieldOf(rebuilt, key), value);
        }
      }
    },
  );

  await check(
    "matchers: each claims its own tag on the original and on the rebuilt WireError, and no other matcher does",
    () => {
      for (const { error, shape, matcher } of CASES) {
        assertMatchers(error, matcher, `the original ${shape._tag}`);
        assertMatchers(
          new WireError(shape),
          matcher,
          `a ${shape._tag} rebuilt`,
        );
      }
      // The Effect classes are distinct: a rebuilt WireError is never an
      // instance of them, which is why matchers read the tag.
      const rebuilt = new WireError(CASES[1].shape);
      assert.equal(rebuilt instanceof UnknownWorktree, false);
      assert.equal(
        new WireError(CASES[0].shape) instanceof UnknownProject,
        false,
      );
      assert.equal(
        new WireError(CASES[4].shape) instanceof BranchNotMerged,
        false,
      );
    },
  );

  await check(
    "hostile shape: __proto__, constructor, prototype, name and stack keys neither pollute nor rename the instance",
    () => {
      // JSON.parse makes "__proto__" an own data key, exactly what a
      // frame off the wire carries.
      const shape = JSON.parse(
        '{"_tag":"Hostile","message":"hostile",' +
          '"__proto__":{"polluted":true},' +
          '"constructor":{"polluted":true},' +
          '"prototype":{"polluted":true},' +
          '"name":"NotTheTag","stack":"forged stack","kept":"yes"}',
      );
      assert.ok(Object.hasOwn(shape, "__proto__"), "the fixture is hostile");
      // Straight into the class (what a caller that skipped the schema
      // would do), and through the schema the frame parse applies.
      const direct = new WireError(shape);
      assert.equal(Object.getPrototypeOf(direct), WireError.prototype);
      assert.equal(direct.polluted, undefined);
      assert.equal(direct.name, "Hostile");
      const rebuilt = new WireError(decodeShape(shape));
      assert.equal(Object.getPrototypeOf(rebuilt), WireError.prototype);
      assert.equal(rebuilt.polluted, undefined);
      assert.equal({}.polluted, undefined, "Object.prototype polluted");
      assert.equal(Error.prototype.polluted, undefined);
      assert.equal(rebuilt.name, "Hostile");
      assert.notEqual(rebuilt.stack, "forged stack");
      assert.equal(rebuilt.constructor, WireError);
      for (const key of ["__proto__", "constructor", "prototype"]) {
        assert.equal(Object.hasOwn(rebuilt, key), false, `${key} landed`);
      }
      assert.equal(rebuilt.kept, "yes");
      // And a hop does not carry the hostile keys on.
      assert.deepEqual(encodeWireError(rebuilt), {
        _tag: "Hostile",
        message: "hostile",
        kept: "yes",
      });
    },
  );

  await check(
    "hop: re-encoding a rebuilt WireError yields the shape it was built from",
    () => {
      for (const { shape } of CASES) {
        assert.deepEqual(encodeWireError(new WireError(shape)), shape);
      }
      // Two hops, and a newer peer's extra field, survive too.
      const newer = {
        _tag: "FromTheFuture",
        message: "later",
        detail: { a: [1] },
      };
      assert.deepEqual(
        encodeWireError(new WireError(encodeWireError(new WireError(newer)))),
        newer,
      );
    },
  );

  await check(
    "schema: WireErrorShapeSchema refuses a missing or empty _tag or a missing message, keeps extra fields, and the res frame carries it additively",
    () => {
      refuses({ message: "m" }, "a missing _tag");
      refuses({ _tag: "", message: "m" }, "an empty _tag");
      refuses({ _tag: 3, message: "m" }, "a non-string _tag");
      refuses({ _tag: "T" }, "a missing message");
      refuses({ _tag: "T", message: 3 }, "a non-string message");
      const extra = { _tag: "T", message: "m", worktreeId: "w1", n: 2 };
      assert.deepEqual(decodeShape(extra), extra);

      // The res frame: an old peer's message-only answer still parses,
      // a new one keeps its error with every field.
      const old = decodeServerFrame({
        t: "res",
        id: 1,
        ok: false,
        message: "boom",
      });
      assert.equal("error" in old, false);
      const typed = decodeServerFrame({
        t: "res",
        id: 2,
        ok: false,
        message: "Unknown worktree: w1",
        error: CASES[1].shape,
      });
      assert.deepEqual(typed.error, CASES[1].shape);
      assert.equal(
        Schema.decodeUnknownExit(ServerFrameSchema)({
          t: "res",
          id: 3,
          ok: false,
          message: "m",
          error: { _tag: "", message: "m" },
        })._tag,
        "Success",
        "a res with a malformed error was dropped",
      );
      // The malformed typed form degrades to absent, so the caller's
      // invoke rejects on the message instead of pending forever on a
      // dropped frame (a NEWER peer's shape this build cannot read).
      const degraded = decodeServerFrame({
        t: "res",
        id: 1,
        ok: false,
        message: "m",
        error: { _tag: "", message: "m" },
      });
      assert.equal(degraded.ok, false);
      assert.equal("error" in degraded ? degraded.error : null, undefined);
      // An empty tag is no tag, on the reader as on the writer.
      assert.equal(errorTagOf({ _tag: "", message: "m" }), undefined);
    },
  );

  await check(
    "tag wins: a tagged error with a different tag whose message holds the legacy text does not match",
    () => {
      assert.equal(
        isEntityGoneError(imposter("Unknown worktree: w1")),
        false,
        "isEntityGoneError read the prose",
      );
      assert.equal(isEntityGoneError(imposter("Unknown project: p1")), false);
      assert.equal(
        isNoDirectConnectionError(imposter("no direct connection to d1")),
        false,
        "isNoDirectConnectionError read the prose",
      );
      assert.equal(
        isBranchNotMergedError(imposter("Branch 'x' has unmerged commits.")),
        false,
        "isBranchNotMergedError read the prose",
      );
      // The same holds for an in-process Effect error of another tag:
      // a BranchNotMerged whose branch name carries entity-gone text.
      assert.equal(
        isEntityGoneError(branchNotMergedError("Unknown worktree: w1")),
        false,
      );
      // And for the refusal matcher, whose legacy text an older peer
      // still sends bare: a foreign tag is never a refusal.
      assert.equal(
        isCommandRefusedError(imposter(COMMAND_REFUSED_MESSAGE)),
        false,
        "isCommandRefusedError read the prose past a foreign tag",
      );
    },
  );

  await check(
    "bounded: a string field longer than the wire bound is cut with an ellipsis, and a short one rides whole",
    () => {
      const long = "x".repeat(MAX_WIRE_FIELD_CHARS + 100);
      class Noisy extends Schema.TaggedError()("Noisy", {
        stdout: Schema.String,
        note: Schema.String,
      }) {}
      const shape = encodeWireError(new Noisy({ stdout: long, note: "ok" }));
      assert.equal(shape.note, "ok");
      assert.equal(shape.stdout.length, MAX_WIRE_FIELD_CHARS + 1);
      assert.ok(shape.stdout.endsWith("…"));
      assert.ok(
        JSON.stringify(shape).length < 2 * MAX_WIRE_FIELD_CHARS,
        "the whole shape stays small",
      );
    },
  );

  await check(
    "legacy: an older peer's message-only Error still matches by its text, and an unrelated one matches nothing",
    () => {
      assertMatchers(
        new Error("Unknown project: p1"),
        "isEntityGoneError",
        "a legacy unknown project",
      );
      assertMatchers(
        new Error("Unknown worktree: w1"),
        "isEntityGoneError",
        "a legacy unknown worktree",
      );
      assertMatchers(
        new Error("no direct connection to d1 (offline)"),
        "isNoDirectConnectionError",
        "a legacy no-direct-connection",
      );
      assertMatchers(
        new Error("Branch 'feat' has unmerged commits."),
        "isBranchNotMergedError",
        "a legacy branch-not-merged",
      );
      assertMatchers(
        new Error(COMMAND_REFUSED_MESSAGE),
        "isCommandRefusedError",
        "a legacy refusal",
      );
      assertMatchers(new Error("boom"), undefined, "a plain failure");
    },
  );

  await check(
    "envelope: settleEnvelope answers ok with the value, a tagged failure with message and error, a plain one with message only, and unwrapEnvelope rebuilds each",
    async () => {
      const okEnvelope = await settleEnvelope(async () => ({ n: 1 }));
      assert.deepEqual(okEnvelope, { ok: true, value: { n: 1 } });
      assert.deepEqual(unwrapEnvelope(okEnvelope), { n: 1 });
      const voidEnvelope = await settleEnvelope(async () => undefined);
      assert.equal(voidEnvelope.ok, true);
      assert.equal(unwrapEnvelope(voidEnvelope), undefined);

      const tagged = await settleEnvelope(async () => {
        throw unknownWorktreeError("w1");
      });
      assert.deepEqual(tagged, {
        ok: false,
        message: "Unknown worktree: w1",
        error: CASES[1].shape,
      });
      // What contextBridge hands the preload is a structured clone, so
      // unwrap a clone rather than the object settleEnvelope built.
      assert.throws(
        () => unwrapEnvelope(structuredClone(tagged)),
        (error) =>
          error instanceof WireError &&
          error._tag === "UnknownWorktree" &&
          error.worktreeId === "w1" &&
          error.message === "Unknown worktree: w1" &&
          isEntityGoneError(error),
      );

      const plain = await settleEnvelope(async () => {
        throw new Error("boom");
      });
      assert.deepEqual(plain, { ok: false, message: "boom" });
      assert.equal("error" in plain, false, "a plain failure grew an error");
      assert.throws(
        () => unwrapEnvelope(structuredClone(plain)),
        (error) =>
          error instanceof Error &&
          !(error instanceof WireError) &&
          errorTagOf(error) === undefined &&
          error.message === "boom",
      );

      // A synchronous throw inside run still settles, and a non-Error
      // rejection keeps its text.
      assert.deepEqual(
        await settleEnvelope(() => {
          throw new Error("sync");
        }),
        { ok: false, message: "sync" },
      );
      assert.deepEqual(
        await settleEnvelope(() => Promise.reject("bare string")),
        { ok: false, message: "bare string" },
      );
    },
  );

  done();
}

main().catch(fail);
