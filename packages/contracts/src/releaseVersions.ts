// Release versions as the app compares them: semver precedence, a
// build's version in the list's spelling, and which releases a
// device's changelog shows. Pure, so the views, the app's update checks
// and the changelog's reader (the app's shared/releases.ts) share it.
import type { Release } from "./schemas/index.ts";

// Semver precedence, as far as release tags need it: the core numbers,
// then a prerelease sorts below its release, identifier by identifier
// (numeric ones numerically and below any word). What parses is the
// engine's rule (parseSemver in semver.ts): x.y.z without leading zeros,
// prerelease identifiers that are non-empty, alphanumeric or hyphens,
// and numeric ones without a leading zero. Anything else sorts below
// everything, so a stray tag can't pass for newest.
const NUMBER = "(0|[1-9]\\d*)";
const IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
  `^v?${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+.*)?$`,
);

export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (left === null || right === null) {
    return (left === null ? 0 : 1) - (right === null ? 0 : 1);
  }
  for (const index of [1, 2, 3]) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return Math.sign(diff);
  }
  const leftPre = left[4]?.split(".") ?? [];
  const rightPre = right[4]?.split(".") ?? [];
  if (leftPre.length === 0 || rightPre.length === 0) {
    return Math.sign(rightPre.length - leftPre.length);
  }
  for (let i = 0; i < Math.max(leftPre.length, rightPre.length); i++) {
    const l = leftPre[i];
    const r = rightPre[i];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Math.sign(Number(l) - Number(r));
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

// A build's version as the release list spells it: a production
// renderer reports its tag ("v2.15.0") and app.getVersion() the bare
// number ("2.15.0"). A build that isn't a release ("dev", "unknown")
// has none, "".
export function releaseVersionOf(raw: string): string {
  return SEMVER.test(raw) ? raw.replace(/^v/, "") : "";
}

// Precedence between two builds' versions, when both are releases:
// -1, 0 or 1 as a is lower than, equal to, or higher than b. null when
// either isn't (a dev build's, or a peer whose welcome hasn't named
// one), which callers read as unknown.
export function compareAppVersions(a: string, b: string): number | null {
  if (releaseVersionOf(a) === "" || releaseVersionOf(b) === "") return null;
  return compareVersions(a, b);
}

export function isPrereleaseVersion(version: string): boolean {
  return SEMVER.exec(version)?.[4] !== undefined;
}

// A device's changelog, newest first. `build` is its version in
// either spelling ("" or "dev" when it has none), and `staged` the
// update waiting for its restart. Prereleases are for the beta ride:
// they show only on a device already on one, or when one is what it
// runs or has staged. GitHub lists by the tagged commit's date, so the
// order is the versions' own.
export function changelogFor(
  releases: readonly Release[],
  build: string,
  staged: string | null,
): Release[] {
  const installed = releaseVersionOf(build);
  const onPrerelease = isPrereleaseVersion(installed);
  return releases
    .filter(
      (release) =>
        onPrerelease ||
        !(release.prerelease || isPrereleaseVersion(release.version)) ||
        release.version === installed ||
        release.version === staged,
    )
    .toSorted((a, b) => compareVersions(b.version, a.version));
}

// Whether a release is part of the move from `from` to `to`: after the
// one, up to and including the other. Moving from a build that isn't a
// release (`from` is ""), only `to` itself is.
export function isBetween(version: string, from: string, to: string): boolean {
  if (compareVersions(version, to) > 0) return false;
  return from === "" ? version === to : compareVersions(version, from) > 0;
}

// The version this build replaced, when it is an update: `previous` is
// the build a window last ran (its record of it, null on a first run),
// and the answer is that release when this one is newer, else null. A
// build that isn't a release, on either side, is never an update, and
// neither is a downgrade.
export function updatedFrom(
  previous: string | null,
  build: string,
): string | null {
  if (previous === null) return null;
  return compareAppVersions(build, previous) === 1
    ? releaseVersionOf(previous)
    : null;
}
