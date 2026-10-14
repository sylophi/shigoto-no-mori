// Release versions as the app compares them: semver precedence, a
// build's version in the list's spelling, and which releases a
// device's changelog shows. Pure, so the views, the app's update checks
// and the changelog's reader (the app's shared/releases.ts) share it.
import * as semver from "semver";
import type { Release } from "./schemas/index.ts";

// Precedence between two version strings. Anything that doesn't parse
// sorts below everything, so a stray tag can't pass for newest.
export function compareVersions(a: string, b: string): number {
  const left = semver.parse(a);
  const right = semver.parse(b);
  if (left === null || right === null) {
    return (left === null ? 0 : 1) - (right === null ? 0 : 1);
  }
  return left.compare(right);
}

// The release line a prerelease belongs to: its core version and its
// identifiers less a trailing counter, so 2.0.0-beta.1 and 2.0.0-beta.7
// share "2.0.0-beta". "" for a full release.
export function releaseChannel(version: semver.SemVer): string {
  const pre = version.prerelease;
  if (pre.length === 0) return "";
  const line =
    pre.length > 1 && typeof pre.at(-1) === "number" ? pre.slice(0, -1) : pre;
  return `${version.major}.${version.minor}.${version.patch}-${line.join(".")}`;
}

// A build's version as the release list spells it: a production
// renderer reports its tag ("v2.15.0") and app.getVersion() the bare
// number ("2.15.0"). A build that isn't a release ("dev", "unknown")
// has none, "".
export function releaseVersionOf(raw: string): string {
  return semver.valid(raw) === null ? "" : raw.replace(/^v/, "");
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
  return semver.prerelease(version) !== null;
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
