// The app's changelog, read from its GitHub releases: the notes each
// release was published with are the changelog, so there is no second
// copy to keep in step. Pure, over an injected fetch, so the desktop
// binding (main, node's fetch) and the web one (the page's) serve the
// same answer, and a check can drive it with a stub.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { UPDATE_FEED_REPO } from "@shared/packaging/updateFeed.mts";
import type { Release } from "@shigomori/contracts/schemas";

export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_FEED_REPO}/releases`;

// The API's page maximum, and the engine's release list reads the
// same one page (updateFeed.ts). Older releases are a click away on GitHub.
const RELEASE_LIST_URL = `https://api.github.com/repos/${UPDATE_FEED_REPO}/releases?per_page=100`;

// The fields read off each entry. Drafts never reach an
// unauthenticated caller, but the flag is dropped on the floor anyway
// rather than trusted to stay that way.
const GitHubReleaseSchema = Schema.Struct({
  tag_name: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  published_at: Schema.optional(Schema.NullOr(Schema.String)),
  prerelease: Schema.Boolean,
  draft: Schema.optional(Schema.Boolean),
  html_url: Schema.String,
});
const decodeReleaseList = Schema.decodeUnknownResult(
  Schema.Array(GitHubReleaseSchema),
);

// The refusal for the hourly limit. It reaches the renderer as a
// message (errors cross IPC as text), where a retry waits on it.
export const RATE_LIMITED =
  "GitHub is rate-limiting requests from this network. Try again later.";

export async function fetchReleases(
  fetchImpl: typeof fetch = fetch,
): Promise<Release[]> {
  let response: Response;
  try {
    response = await fetchImpl(RELEASE_LIST_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new Error("Couldn't reach GitHub.");
  }
  // Unauthenticated calls get 60 an hour per address. GitHub spends
  // that budget with a 403 that says so, and 429 is its secondary
  // limit (the same reading as the engine's updateFeed.ts).
  if (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0")
  ) {
    throw new Error(RATE_LIMITED);
  }
  if (!response.ok) {
    throw new Error(`GitHub answered HTTP ${response.status}.`);
  }
  const parsed = decodeReleaseList(await response.json());
  if (Result.isFailure(parsed)) {
    throw new Error("GitHub answered with a release list this app can't read.");
  }
  return parsed.success
    .filter((release) => release.draft !== true)
    .map((release) => ({
      version: release.tag_name.replace(/^v/, ""),
      notes: release.body ?? "",
      publishedAt: release.published_at ?? null,
      prerelease: release.prerelease,
      url: release.html_url,
    }));
}

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
