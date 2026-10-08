// The updater's semver: the Go sm's table cases (cli/updater_test.go),
// then properties over generated versions and generated junk.
import assert from "node:assert/strict";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import {
  compareSemver,
  formatSemver,
  parseSemver,
  releaseChannel,
  type Semver,
} from "../src/semver.ts";

const parsed = (raw: string): Semver => {
  const version = parseSemver(raw);
  assert.ok(version, `parseSemver(${raw}) failed`);
  return version;
};

// A property that holds for every generated value, or the shrunk input
// that broke it.
const holds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean,
  runs = 1000,
) => {
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(arbitrary, property, { runs }),
  );
  assert.equal(Arbitrary.formatCheckFailure(result), undefined);
};

describe("parseSemver", () => {
  it("reads what Go reads, and refuses what Go refuses", () => {
    const cases: ReadonlyArray<[string, string | undefined]> = [
      ["1.7.1", "1.7.1"],
      ["v1.7.1", "1.7.1"],
      ["2.0.0-beta.2", "2.0.0-beta.2"],
      ["v2.0.0-test.keychain-prompts.1", "2.0.0-test.keychain-prompts.1"],
      ["2.0.0-beta.2+build.5", "2.0.0-beta.2"],
      ["2.0.0-0", "2.0.0-0"],
      ["dev", undefined],
      ["0.17", undefined],
      ["1.02.0", undefined],
      ["2.0.0-", undefined],
      ["2.0.0-beta..1", undefined],
      ["2.0.0-beta_1", undefined],
      ["2.0.0-beta.01", undefined],
      // Go's Atoi takes a sign, which the round trip then refuses.
      ["+1.2.3", undefined],
      ["1.-2.3", undefined],
      ["vv1.2.3", undefined],
      // Build metadata is dropped unread, as Go drops it.
      ["1.2.3+!!", "1.2.3"],
      ["1.2.3-a+b+c", "1.2.3-a"],
      // A core number fits Go's int.
      ["9223372036854775807.0.0", "9223372036854775807.0.0"],
      ["9223372036854775808.0.0", undefined],
      // Prerelease counters have no such bound.
      ["1.0.0-99999999999999999999999", "1.0.0-99999999999999999999999"],
      ["1.0.0-é", undefined],
    ];
    for (const [raw, want] of cases) {
      const version = parseSemver(raw);
      assert.equal(
        version === undefined ? undefined : formatSemver(version),
        want,
        raw,
      );
    }
  });
});

describe("compareSemver", () => {
  it("orders the spec's example and the shapes this repo tags", () => {
    // Each strictly lower than the next.
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.7.1",
      "1.10.0",
      "2.0.0-beta.1",
      "2.0.0-beta.2",
      "2.0.0-test.keychain-prompts.1",
      "2.0.0",
    ].map(parsed);
    ordered.forEach((a, i) => {
      ordered.forEach((b, j) => {
        assert.equal(
          compareSemver(a, b),
          Math.sign(i - j),
          `${formatSemver(a)} vs ${formatSemver(b)}`,
        );
      });
    });
  });

  it("compares big counters as numbers", () => {
    assert.equal(
      compareSemver(parsed("1.0.0-100000000000000000001"), parsed("1.0.0-99")),
      1,
    );
    assert.equal(
      compareSemver(
        parsed("9223372036854775807.0.0"),
        parsed("9223372036854775806.0.0"),
      ),
      1,
    );
  });
});

describe("releaseChannel", () => {
  it("names the line a prerelease belongs to", () => {
    const cases: Record<string, string> = {
      "1.7.1": "",
      "2.0.0-beta.1": "2.0.0-beta",
      "2.0.0-beta.7": "2.0.0-beta",
      "2.0.0-beta": "2.0.0-beta",
      "2.0.0-test.keychain-prompts.1": "2.0.0-test.keychain-prompts",
      "2.1.0-beta.1": "2.1.0-beta",
      "2.0.0-1": "2.0.0-1",
    };
    for (const [raw, want] of Object.entries(cases)) {
      assert.equal(releaseChannel(parsed(raw)), want, raw);
    }
  });
});

// --- properties ---

const small = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 12 })),
);
const word = Arbitrary.schema(
  Schema.Literals([
    "alpha",
    "beta",
    "rc",
    "test",
    "keychain-prompts",
    "x-1",
    "0a",
    "-",
  ]),
);
const identifier = Arbitrary.flatMap(
  Arbitrary.schema(Schema.Boolean),
  (numeric) => (numeric ? Arbitrary.map(small, String) : word),
);
const version: Arbitrary.Arbitrary<Semver> = Arbitrary.map(
  Arbitrary.all({
    major: small,
    minor: small,
    patch: small,
    pre: Arbitrary.array(identifier, { maxLength: 4 }),
  }),
  (v) => ({
    major: BigInt(v.major),
    minor: BigInt(v.minor),
    patch: BigInt(v.patch),
    pre: v.pre,
  }),
);

// The semver.org grammar, with the Go sm's differences: one optional
// leading "v", build metadata cut off at the first "+" and not checked,
// and core numbers within Go's int.
const OFFICIAL =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
const reference = (raw: string) => {
  const bare = (raw.startsWith("v") ? raw.slice(1) : raw).split("+")[0] ?? "";
  const match = OFFICIAL.exec(bare);
  return (
    match !== null &&
    match
      .slice(1, 4)
      .every((part) => BigInt(part ?? "0") <= 9_223_372_036_854_775_807n)
  );
};

// Strings built from the pieces versions are made of, and the ones that
// trip parsers up.
const junk = Arbitrary.map(
  Arbitrary.array(
    Arbitrary.schema(
      Schema.Literals([
        "0",
        "1",
        "01",
        "12",
        ".",
        "-",
        "+",
        "v",
        "beta",
        "a_b",
        " ",
        "9223372036854775807",
        "9223372036854775808",
        "1.2.3",
      ]),
    ),
    { maxLength: 8 },
  ),
  (pieces) => pieces.join(""),
);

describe("semver properties", () => {
  it("formats and parses back to the same version", () =>
    holds(version, (v) => {
      const text = formatSemver(v);
      return [text, `v${text}`, `${text}+build.7`].every((raw) => {
        const back = parseSemver(raw);
        return back !== undefined && formatSemver(back) === text;
      });
    }));

  it("accepts exactly the grammar, whatever the input", () =>
    holds(
      junk,
      (raw) => {
        const read = parseSemver(raw);
        if ((read !== undefined) !== reference(raw)) return false;
        if (read === undefined) return true;
        const bare = (raw.startsWith("v") ? raw.slice(1) : raw).split("+")[0];
        return formatSemver(read) === bare;
      },
      3000,
    ));

  it("is a total order", () =>
    holds(Arbitrary.all([version, version, version]), ([a, b, c]) => {
      const ab = compareSemver(a, b);
      if (compareSemver(a, a) !== 0) return false;
      if (ab !== -compareSemver(b, a)) return false;
      if ((ab === 0) !== (formatSemver(a) === formatSemver(b))) return false;
      // Transitive: a <= b and b <= c means a <= c.
      return !(ab <= 0 && compareSemver(b, c) <= 0) || compareSemver(a, c) <= 0;
    }));

  it("ranks a prerelease below the release it leads up to", () =>
    holds(version, (v) =>
      v.pre.length === 0
        ? compareSemver(v, { ...v, pre: ["rc", "1"] }) === 1
        : compareSemver(v, { ...v, pre: [] }) === -1,
    ));

  it("keeps a channel across its counter", () =>
    holds(Arbitrary.all([version, small, small]), ([v, n, m]) => {
      if (v.pre.length === 0) return releaseChannel(v) === "";
      const at = (count: number) =>
        releaseChannel({ ...v, pre: [...v.pre, String(count)] });
      return at(n) === at(m) && at(n) === formatSemver(v);
    }));
});
