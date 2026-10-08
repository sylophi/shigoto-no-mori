// What the updater reads from the two feeds and keeps of the release
// list, the release a prerelease build moves to, the dates the feeds
// carry, and GitHub's rate limit.
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  compareSemver,
  isPrerelease,
  parseSemver,
  releaseChannel,
  type Semver,
} from "./semver.ts";

// What a feed said about the release to move to.
export type ReleaseInfo = {
  readonly url: string;
  readonly version: string;
  readonly notes: string;
  // ISO 8601, or "" when the feed's date is absent or unreadable.
  readonly releaseDate: string;
};

// The feeds are read as Go reads them into its structs: a missing or
// null field is its zero value ("", false, none), and only a value of
// the wrong type fails. GitHub sends null for an empty body or an
// unpublished date.
const Text = Schema.optional(Schema.NullOr(Schema.String));
const Flag = Schema.optional(Schema.NullOr(Schema.Boolean));

// The update server's answer for a release ahead of the build. A missing
// URL or name is its own failure, told after decoding.
export const FeedAnswer = Schema.NullOr(
  Schema.Struct({ url: Text, name: Text, notes: Text, pub_date: Text }),
);

// One entry of the GitHub release list, the fields the picker reads.
// Drafts never reach an unauthenticated caller, so the draft flag isn't
// read.
const GitHubRelease = Schema.NullOr(
  Schema.Struct({
    tag_name: Text,
    prerelease: Flag,
    body: Text,
    published_at: Text,
    assets: Schema.optional(
      Schema.NullOr(
        Schema.Array(
          Schema.NullOr(
            Schema.Struct({ name: Text, browser_download_url: Text }),
          ),
        ),
      ),
    ),
  }),
);
type GitHubRelease = typeof GitHubRelease.Type;

// A null list is an empty one.
export const ReleaseList = Schema.NullOr(Schema.Array(GitHubRelease));

// The last release list the API served, kept as updates/release-list.json
// in the shape the Go sm keeps it.
export const ReleaseListCache = Schema.Struct({
  // The endpoint it came from: a stand-in's list never answers for the
  // real one, or the reverse.
  url: Schema.String,
  fetchedAt: Schema.String,
  etag: Schema.optional(Schema.String),
  retryAt: Schema.optional(Schema.String),
  // The list as the API sent it, decoded on use.
  body: Schema.optionalKey(Schema.Unknown),
});

// --- picking a release -------------------------------------------------------

// The zip maker names its asset "<product>-darwin-<arch>-<version>.zip",
// and GitHub turns the product name's spaces into dots on upload.
const zipAssetUrl = (release: GitHubRelease, marker: string) =>
  (release?.assets ?? []).find((asset) => {
    const name = asset?.name ?? "";
    return name.endsWith(".zip") && name.includes(marker);
  })?.browser_download_url ?? "";

// The release a prerelease build moves to, or undefined when none is
// ahead: the highest of the full releases and of the prereleases in the
// build's own channel that have a zip for this arch. A full 2.0.0 beats
// every 2.0.0-beta.N, which ends the beta. A release flagged prerelease
// under a full release's tag stays hidden, as the update server hides
// it, and one without its zip yet (the workflow uploads assets minutes
// after the tag) is skipped, as the update server skips it.
export const pickRelease = (
  current: Semver,
  releases: ReadonlyArray<GitHubRelease>,
  arch: string,
): ReleaseInfo | undefined => {
  const channel = releaseChannel(current);
  const marker = `-darwin-${arch}-`;
  let best: { release: GitHubRelease; version: Semver; url: string } | null =
    null;
  for (const release of releases) {
    const version = parseSemver(release?.tag_name ?? "");
    if (version === undefined || compareSemver(version, current) <= 0) {
      continue;
    }
    if (best !== null && compareSemver(version, best.version) <= 0) continue;
    if (isPrerelease(version)) {
      if (releaseChannel(version) !== channel) continue;
    } else if (release?.prerelease === true) {
      continue;
    }
    const url = zipAssetUrl(release, marker);
    if (url === "") continue;
    best = { release, version, url };
  }
  if (best === null) return undefined;
  return {
    url: best.url,
    version: trimV(best.release?.tag_name ?? ""),
    notes: best.release?.body ?? "",
    releaseDate: parseReleaseDate(best.release?.published_at ?? ""),
  };
};

export const trimV = (tag: string) =>
  tag.startsWith("v") ? tag.slice(1) : tag;

// --- dates -------------------------------------------------------------------

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// RFC 3339 in epoch ms, undefined for anything else.
export const parseRfc3339 = (text: string) => {
  const ms = RFC3339.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const RFC1123 =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}:\d{2}:\d{2}) (?:([+-]\d{2})(\d{2})|[A-Z]{3,5})$/;

// RFC 1123 with a numeric zone (Go's RFC1123Z) or an abbreviation
// (RFC1123), in epoch ms. Every abbreviation reads as UTC: GMT and UTC
// are, and Go itself reads one it doesn't know as UTC.
const parseRfc1123 = (text: string) => {
  const match = RFC1123.exec(text);
  const month = MONTHS.indexOf(match?.[2] ?? "") + 1;
  if (match === null || month === 0) return undefined;
  const [, day, , year, time, hours, minutes] = match;
  const zone = hours === undefined ? "Z" : `${hours}:${minutes}`;
  return parseRfc3339(
    `${year}-${String(month).padStart(2, "0")}-${day}T${time}${zone}`,
  );
};

// The feeds pass GitHub's date through, put in UTC to the second.
// Anything unreadable is "" rather than a failed update.
export const parseReleaseDate = (raw: string) => {
  const ms = parseRfc3339(raw) ?? parseRfc1123(raw);
  return ms === undefined
    ? ""
    : new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
};

// updater.json as `sm update` reads it: the app's pid, its version, and
// its state's kind and message. Only a missing or non-positive pid makes
// it no app.
export type AppStatus = {
  readonly pid: number;
  readonly appVersion: string;
  readonly state: { readonly kind: string; readonly message: string };
};

const textOf = (value: unknown) => (typeof value === "string" ? value : "");

export const appStatusOf = (value: unknown): AppStatus | undefined => {
  if (!Predicate.isObject(value)) return undefined;
  const pid = value["pid"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const state = Predicate.isObject(value["state"]) ? value["state"] : {};
  return {
    pid,
    appVersion: textOf(value["appVersion"]),
    state: { kind: textOf(state["kind"]), message: textOf(state["message"]) },
  };
};

const pad = (value: number, width = 2) =>
  String(Math.abs(value)).padStart(width, "0");

// Local time in RFC 3339, as the install log stamps its lines.
export const formatLocalRfc3339 = (ms: number) => {
  const date = new Date(ms);
  const east = -date.getTimezoneOffset();
  const zone =
    east === 0
      ? "Z"
      : `${east < 0 ? "-" : "+"}${pad(Math.trunc(east / 60))}:${pad(east % 60)}`;
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
};

// Local time as Go's time.Kitchen prints it: 3:04PM.
export const formatKitchen = (ms: number) => {
  const date = new Date(ms);
  const hours = date.getHours();
  return `${hours % 12 === 0 ? 12 : hours % 12}:${pad(date.getMinutes())}${hours < 12 ? "AM" : "PM"}`;
};

// --- GitHub's rate limit -----------------------------------------------------

// GitHub spends the hourly budget with a 403 that says so, and 429 is its
// secondary limit. Any other 403 is a real refusal.
export const isRateLimited = (status: number, remaining: string | undefined) =>
  status === 429 || (status === 403 && remaining === "0");

const HOUR = 3_600_000;

const seconds = (text: string | undefined) =>
  text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;

// When the limit lifts: X-RateLimit-Reset (unix seconds), else
// Retry-After (seconds), else an hour. Never more than an hour out, so a
// bogus header can't park checks for a day.
export const rateLimitReset = (
  headers: { readonly reset?: string; readonly retryAfter?: string },
  now: number,
) => {
  const limit = now + HOUR;
  const reset = seconds(headers.reset);
  if (reset !== undefined) {
    const at = reset * 1000;
    if (at > now && at < limit) return at;
  }
  const after = seconds(headers.retryAfter);
  if (after !== undefined && after > 0 && after < 3600) {
    return now + after * 1000;
  }
  return limit;
};
