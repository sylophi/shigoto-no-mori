// What the updater reads from the two feeds and keeps of the release
// list, the release a prerelease build moves to, the dates the feeds
// carry, and GitHub's rate limit.
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { parse, type SemVer } from "semver";
import { APP_REPO, isV3Release } from "./flavor.ts";

// GitHub's list of the app's releases, the API's one page maximum: the
// updater's release list and the app's changelog alike.
export const RELEASE_LIST_URL = `https://api.github.com/repos/${APP_REPO}/releases?per_page=100`;

// What a feed said about the release to move to.
export type ReleaseInfo = {
  readonly url: string;
  readonly version: string;
  readonly notes: string;
  // ISO 8601, or "" when the feed's date is absent or unreadable.
  readonly releaseDate: string;
};

// The feeds are read as Go read them into its structs: a missing or
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

// One entry of the GitHub release list, the fields the picker and the
// changelog read. Drafts never reach an unauthenticated caller, and the
// changelog drops one anyway rather than trust that to stay so.
const GitHubRelease = Schema.NullOr(
  Schema.Struct({
    tag_name: Text,
    prerelease: Flag,
    draft: Flag,
    body: Text,
    published_at: Text,
    html_url: Text,
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
// in the shape the Go sm kept it.
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

// The release a build moves to, or undefined when none is ahead. Only a
// release above the build in semver's order is offered, which ranks
// alpha below beta below rc below the full release, so a build never
// moves back a stage. A prerelease build (`releases`) takes the highest
// later prerelease, of any stage, or full release, and a full build full
// releases alone. Neither takes a prerelease of 3.0.0 (flavor.ts
// isV3Release). A v3 build (`v3`) takes those alone: a full release,
// 3.0.0 included, is another flavor's bundle. Either way a release
// flagged prerelease under a full release's tag stays hidden, as the
// update server hides it, and one without its zip for this arch yet (the
// workflow uploads assets minutes after the tag) is skipped, as the
// update server skips it.
export const pickRelease = (
  current: SemVer,
  releases: ReadonlyArray<GitHubRelease>,
  arch: string,
  line: "releases" | "v3" = "releases",
): ReleaseInfo | undefined => {
  const onPrerelease = current.prerelease.length > 0;
  const marker = `-darwin-${arch}-`;
  let best: { release: GitHubRelease; version: SemVer; url: string } | null =
    null;
  for (const release of releases) {
    const tag = release?.tag_name ?? "";
    const version = parse(tag);
    if (version === null || version.compare(current) <= 0) continue;
    if (best !== null && version.compare(best.version) <= 0) continue;
    if (line === "v3") {
      if (!isV3Release(tag)) continue;
    } else if (isV3Release(tag)) {
      continue;
    } else if (version.prerelease.length > 0) {
      if (!onPrerelease) continue;
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

// The longest the rate limit is waited out (rateLimitReset).
export const RATE_LIMIT_WAIT_MAX = 3_600_000;

const seconds = (text: string | undefined) =>
  text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;

// When the limit lifts: X-RateLimit-Reset (unix seconds), else
// Retry-After (seconds), else an hour. Never more than an hour out, so a
// bogus header can't park checks for a day.
export const rateLimitReset = (
  headers: { readonly reset?: string; readonly retryAfter?: string },
  now: number,
) => {
  const limit = now + RATE_LIMIT_WAIT_MAX;
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
