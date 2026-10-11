// Release versions as the app compares them: semver precedence, a
// build's version in the list's spelling, and which releases a
// device's changelog shows. Pure, so the views, the app's update checks
// and the changelog's reader (the app's shared/releases.ts) share it.
import type { Release } from "./schemas/index.ts";
import { compareSemver, isPrerelease, parseSemver } from "./semver.ts";

// Precedence between two version strings. Anything that doesn't parse
// (parseSemver) sorts below everything, so a stray tag can't pass for
// newest.
export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === undefined || right === undefined) {
    return (left === undefined ? 0 : 1) - (right === undefined ? 0 : 1);
  }
  return compareSemver(left, right);
}

// A build's version as the release list spells it: a production
// renderer reports its tag ("v2.15.0") and app.getVersion() the bare
// number ("2.15.0"). A build that isn't a release ("dev", "unknown")
// has none, "".
export function releaseVersionOf(raw: string): string {
  return parseSemver(raw) === undefined ? "" : raw.replace(/^v/, "");
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
  const parsed = parseSemver(version);
  return parsed !== undefined && isPrerelease(parsed);
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
