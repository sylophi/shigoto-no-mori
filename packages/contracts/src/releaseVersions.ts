import * as semver from "semver";
import type { Release } from "./schemas/index.ts";

// Anything that doesn't parse sorts below everything, so a stray tag
// can't pass for newest.
export function compareVersions(a: string, b: string): number {
  const left = semver.parse(a);
  const right = semver.parse(b);
  if (left === null || right === null) {
    return (left === null ? 0 : 1) - (right === null ? 0 : 1);
  }
  return left.compare(right);
}

// Less a trailing counter: 2.0.0-beta.1 and 2.0.0-beta.7 share
// "2.0.0-beta". "" for a full release.
export function releaseChannel(version: semver.SemVer): string {
  const pre = version.prerelease;
  if (pre.length === 0) return "";
  const line =
    pre.length > 1 && typeof pre.at(-1) === "number" ? pre.slice(0, -1) : pre;
  return `${version.major}.${version.minor}.${version.patch}-${line.join(".")}`;
}

// A renderer reports its tag ("v2.15.0"), app.getVersion() the bare
// number. "" for a build that isn't a release.
export function releaseVersionOf(raw: string): string {
  return semver.valid(raw) === null ? "" : raw.replace(/^v/, "");
}

// null when either isn't a release, which callers read as unknown.
export function compareAppVersions(a: string, b: string): number | null {
  if (releaseVersionOf(a) === "" || releaseVersionOf(b) === "") return null;
  return compareVersions(a, b);
}

export function isPrereleaseVersion(version: string): boolean {
  return semver.prerelease(version) !== null;
}

// Newest first. Prereleases show only on a device already on one, or
// when one is what it runs or has staged. GitHub lists by the tagged
// commit's date, so the order is the versions' own.
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

// After `from`, up to and including `to`; from "" (not a release), only
// `to` itself.
export function isBetween(version: string, from: string, to: string): boolean {
  if (compareVersions(version, to) > 0) return false;
  return from === "" ? version === to : compareVersions(version, from) > 0;
}

// `previous`: the build a window last ran. Not a release on either side,
// or a downgrade, is never an update.
export function updatedFrom(
  previous: string | null,
  build: string,
): string | null {
  if (previous === null) return null;
  return compareAppVersions(build, previous) === 1
    ? releaseVersionOf(previous)
    : null;
}
