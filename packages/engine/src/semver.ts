// Just enough semver 2.0.0 for the updater: parsing, precedence, and the
// channel a prerelease belongs to. The update server compares full
// releases itself, but it hides prereleases, so a prerelease build ranks
// the release list on its own. Written to the Go sm's rules (cli/semver.go)
// rather than taken from a library, so the two never disagree on a tag.

export type Semver = {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  // The prerelease identifiers ("beta", "2"), empty for a full release.
  // Build metadata is dropped when parsing, as it never takes part in
  // precedence.
  readonly pre: ReadonlyArray<string>;
};

// Go's int, which bounds each core number.
const MAX_INT = 9_223_372_036_854_775_807n;

const NUMBER = /^(?:0|[1-9][0-9]*)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const NUMERIC = /^[0-9]+$/;

export const isPrerelease = (version: Semver) => version.pre.length > 0;

export const formatSemver = (version: Semver) =>
  `${version.major}.${version.minor}.${version.patch}${
    isPrerelease(version) ? `-${version.pre.join(".")}` : ""
  }`;

// A core number as Go's Atoi reads it, refusing the signs and leading
// zeros Atoi would let through.
const coreNumber = (part: string) => {
  if (!NUMBER.test(part)) return undefined;
  const value = BigInt(part);
  return value <= MAX_INT ? value : undefined;
};

// Accepts one leading "v": release tags carry it, a build's own version
// doesn't.
export const parseSemver = (raw: string): Semver | undefined => {
  const unprefixed = raw.startsWith("v") ? raw.slice(1) : raw;
  const plus = unprefixed.indexOf("+");
  const bare = plus === -1 ? unprefixed : unprefixed.slice(0, plus);
  const dash = bare.indexOf("-");
  const core = dash === -1 ? bare : bare.slice(0, dash);
  const parts = core.split(".");
  if (parts.length !== 3) return undefined;
  const [major, minor, patch] = parts.map(coreNumber);
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  if (dash === -1) return { major, minor, patch, pre: [] };
  const pre = bare.slice(dash + 1).split(".");
  // A numeric identifier with a leading zero is invalid, and would sort
  // wrong too ("05" above "9").
  const valid = pre.every(
    (id) =>
      IDENTIFIER.test(id) &&
      !(NUMERIC.test(id) && id.length > 1 && id.startsWith("0")),
  );
  return valid ? { major, minor, patch, pre } : undefined;
};

const compareNumbers = (a: bigint | number, b: bigint | number) =>
  a < b ? -1 : a > b ? 1 : 0;

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Numeric identifiers compare as numbers and rank below alphanumeric
// ones, which compare as ASCII.
const compareIdentifiers = (a: string, b: string) => {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) {
    return compareNumbers(a.length, b.length) || compareStrings(a, b);
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return compareStrings(a, b);
};

// Precedence: -1, 0 or 1 as `a` is lower than, equal to or higher than
// `b`.
export const compareSemver = (a: Semver, b: Semver): -1 | 0 | 1 => {
  const core =
    compareNumbers(a.major, b.major) ||
    compareNumbers(a.minor, b.minor) ||
    compareNumbers(a.patch, b.patch);
  if (core !== 0) return core;
  // A prerelease ranks below the full release it leads up to.
  if (isPrerelease(a) !== isPrerelease(b)) return isPrerelease(a) ? -1 : 1;
  for (let i = 0; i < a.pre.length && i < b.pre.length; i++) {
    const order = compareIdentifiers(a.pre[i] ?? "", b.pre[i] ?? "");
    if (order !== 0) return order;
  }
  return compareNumbers(a.pre.length, b.pre.length);
};

// The release line a prerelease belongs to: its core version and its
// identifiers less a trailing counter, so 2.0.0-beta.1 and 2.0.0-beta.7
// share "2.0.0-beta" while 2.0.0-test.keychain.1 and 2.1.0-beta.1 are each
// a line of their own. "" for a full release.
export const releaseChannel = (version: Semver) => {
  if (!isPrerelease(version)) return "";
  const last = version.pre.at(-1) ?? "";
  const pre =
    version.pre.length > 1 && NUMERIC.test(last)
      ? version.pre.slice(0, -1)
      : version.pre;
  return formatSemver({ ...version, pre });
};
