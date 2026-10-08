// What the updater reads from the network and from the files it shares
// with the Go sm and the app, decoded as Go's encoding/json decodes into
// a struct: a key names a field in any case, null leaves the field as it
// was, a value of the wrong type fails the whole decode, and unknown keys
// are ignored. Then the release a prerelease build moves to, the dates
// the feeds carry, and GitHub's rate limit.
import * as Result from "effect/Result";
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

// One entry of the GitHub release list, the fields the picker reads.
// Drafts never reach an unauthenticated caller, so the draft flag isn't
// read: a draft is ranked like any other release.
export type GitHubRelease = {
  readonly tagName: string;
  readonly prerelease: boolean;
  readonly body: string;
  readonly publishedAt: string;
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
};

// --- decoding as Go does -----------------------------------------------------

type Decoded<A> = Result.Result<A, string>;

const kindOf = (value: unknown) =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value === "object"
        ? "object"
        : typeof value;

const isObject = (value: unknown): value is Record<string, unknown> =>
  kindOf(value) === "object";

// A struct field filled from an object: every key that names it, in any
// case, in order, so the last one wins. Null leaves the field as it was.
const field = <A>(
  object: Record<string, unknown>,
  name: string,
  zero: A,
  decode: (value: unknown) => Decoded<A>,
): Decoded<A> => {
  let current: Decoded<A> = Result.succeed(zero);
  const folded = name.toLowerCase();
  for (const [key, value] of Object.entries(object)) {
    if (key.toLowerCase() !== folded || value === null) continue;
    current = decode(value);
    if (Result.isFailure(current)) return current;
  }
  return current;
};

const mismatch = (value: unknown, into: string): Decoded<never> =>
  Result.fail(`cannot unmarshal ${kindOf(value)} into ${into}`);

const string = (value: unknown): Decoded<string> =>
  typeof value === "string" ? Result.succeed(value) : mismatch(value, "string");

const boolean = (value: unknown): Decoded<boolean> =>
  typeof value === "boolean" ? Result.succeed(value) : mismatch(value, "bool");

const integer = (value: unknown): Decoded<number> =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? Result.succeed(value)
    : mismatch(value, "int");

// A time.Time as it unmarshals: RFC 3339 to the second, in epoch ms.
const time = (value: unknown): Decoded<number> => {
  if (typeof value !== "string") return mismatch(value, "time.Time");
  const ms = parseRfc3339(value);
  return ms === undefined
    ? Result.fail(`parsing time ${JSON.stringify(value)}`)
    : Result.succeed(ms);
};

// Go's zero time.Time, 0001-01-01T00:00:00Z.
export const ZERO_TIME = -62_135_596_800_000;

// A struct: an object, or null for every field at its zero value.
const struct = <A>(
  value: unknown,
  into: string,
  zero: A,
  fields: (object: Record<string, unknown>) => Decoded<A>,
): Decoded<A> =>
  value === null
    ? Result.succeed(zero)
    : isObject(value)
      ? fields(value)
      : mismatch(value, into);

// A slice: an array, or null for none.
const slice = <A>(
  value: unknown,
  into: string,
  item: (value: unknown) => Decoded<A>,
): Decoded<ReadonlyArray<A>> => {
  if (value === null) return Result.succeed([]);
  if (!Array.isArray(value)) return mismatch(value, into);
  return Result.all(value.map(item));
};

// JSON text, or why it isn't.
export const parseJson = (text: string): Decoded<unknown> => {
  try {
    return Result.succeed(JSON.parse(text));
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : String(error));
  }
};

// The update server's answer for a release ahead of the build.
type FeedAnswer = {
  readonly url: string;
  readonly name: string;
  readonly notes: string;
  readonly pubDate: string;
};

const NO_FEED_ANSWER: FeedAnswer = {
  url: "",
  name: "",
  notes: "",
  pubDate: "",
};

export const decodeFeedAnswer = (value: unknown): Decoded<FeedAnswer> =>
  struct(value, "feed answer", NO_FEED_ANSWER, (object) =>
    Result.all({
      url: field(object, "url", "", string),
      name: field(object, "name", "", string),
      notes: field(object, "notes", "", string),
      pubDate: field(object, "pub_date", "", string),
    }),
  );

const NO_RELEASE: GitHubRelease = {
  tagName: "",
  prerelease: false,
  body: "",
  publishedAt: "",
  assets: [],
};

const decodeAsset = (value: unknown) =>
  struct(value, "asset", { name: "", url: "" }, (object) =>
    Result.all({
      name: field(object, "name", "", string),
      url: field(object, "browser_download_url", "", string),
    }),
  );

const decodeRelease = (value: unknown): Decoded<GitHubRelease> =>
  struct(value, "release", NO_RELEASE, (object) =>
    Result.all({
      tagName: field(object, "tag_name", "", string),
      prerelease: field(object, "prerelease", false, boolean),
      body: field(object, "body", "", string),
      publishedAt: field(object, "published_at", "", string),
      assets: field(object, "assets", [], (assets) =>
        slice(assets, "assets", decodeAsset),
      ),
    }),
  );

export const decodeReleaseList = (
  value: unknown,
): Decoded<ReadonlyArray<GitHubRelease>> =>
  slice(value, "release list", decodeRelease);

// The last release list the API served, as kept in
// updates/release-list.json. Times are epoch ms, ZERO_TIME for none.
export type ReleaseListCache = {
  // The endpoint it came from: a stand-in's list never answers for the
  // real one, or the reverse.
  readonly url: string;
  readonly fetchedAt: number;
  readonly etag: string;
  readonly retryAt: number;
  // The list as the API sent it, decoded on use. Undefined when the file
  // has none.
  readonly body: unknown;
};

export const decodeReleaseListCache = (
  value: unknown,
): Decoded<ReleaseListCache> =>
  struct(
    value,
    "release list cache",
    {
      url: "",
      fetchedAt: ZERO_TIME,
      etag: "",
      retryAt: ZERO_TIME,
      body: undefined,
    },
    (object) =>
      Result.map(
        Result.all({
          url: field(object, "url", "", string),
          fetchedAt: field(object, "fetchedAt", ZERO_TIME, time),
          etag: field(object, "etag", "", string),
          retryAt: field(object, "retryAt", ZERO_TIME, time),
        }),
        (fields) => ({
          ...fields,
          // Raw JSON keeps even a null, which then reads as no releases.
          body: Object.entries(object).findLast(
            ([key]) => key.toLowerCase() === "body",
          )?.[1],
        }),
      ),
  );

// The file's text: Go's layout, two-space indents and a final newline.
export const encodeReleaseListCache = (cache: ReleaseListCache) =>
  `${JSON.stringify(
    {
      url: cache.url,
      fetchedAt: formatTimeJson(cache.fetchedAt),
      ...(cache.etag === "" ? {} : { etag: cache.etag }),
      retryAt: formatTimeJson(cache.retryAt),
      body: cache.body,
    },
    null,
    2,
  )}\n`;

// The verified bundle in updates/staged, as its manifest describes it.
// The app reads the same file (StagedManifestSchema).
export type StagedManifest = {
  readonly version: string;
  readonly bundleName: string;
  readonly notes: string;
  readonly releaseDate: string;
};

export const decodeStagedManifest = (value: unknown) =>
  struct(
    value,
    "staged manifest",
    { version: "", bundleName: "", notes: "", releaseDate: "" },
    (object) =>
      Result.all({
        version: field(object, "version", "", string),
        bundleName: field(object, "bundleName", "", string),
        notes: field(object, "notes", "", string),
        releaseDate: field(object, "releaseDate", "", string),
      }),
  );

export const encodeStagedManifest = (manifest: StagedManifest) =>
  `${JSON.stringify(
    {
      version: manifest.version,
      bundleName: manifest.bundleName,
      ...(manifest.notes === "" ? {} : { notes: manifest.notes }),
      ...(manifest.releaseDate === ""
        ? {}
        : { releaseDate: manifest.releaseDate }),
    },
    null,
    2,
  )}\n`;

// What the running app publishes in updater.json, the part `sm update`
// reads: who it is, and whether its last install failed.
export type UpdaterStatus = {
  readonly pid: number;
  readonly appVersion: string;
  readonly state: { readonly kind: string; readonly message: string };
};

const NO_STATE = { kind: "", message: "" };

export const decodeUpdaterStatus = (value: unknown) =>
  struct(
    value,
    "updater status",
    { pid: 0, appVersion: "", state: NO_STATE },
    (object) =>
      Result.all({
        pid: field(object, "pid", 0, integer),
        appVersion: field(object, "appVersion", "", string),
        state: field(object, "state", NO_STATE, (state) =>
          struct(state, "state", NO_STATE, (fields) =>
            Result.all({
              kind: field(fields, "kind", "", string),
              message: field(fields, "message", "", string),
            }),
          ),
        ),
      }),
  );

// --- picking a release -------------------------------------------------------

// The zip maker names its asset "<product>-darwin-<arch>-<version>.zip",
// and GitHub turns the product name's spaces into dots on upload.
const zipAssetUrl = (release: GitHubRelease, marker: string) =>
  release.assets.find(
    (asset) => asset.name.endsWith(".zip") && asset.name.includes(marker),
  )?.url ?? "";

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
    const version = parseSemver(release.tagName);
    if (version === undefined || compareSemver(version, current) <= 0) {
      continue;
    }
    if (best !== null && compareSemver(version, best.version) <= 0) continue;
    if (isPrerelease(version)) {
      if (releaseChannel(version) !== channel) continue;
    } else if (release.prerelease) {
      continue;
    }
    const url = zipAssetUrl(release, marker);
    if (url === "") continue;
    best = { release, version, url };
  }
  if (best === null) return undefined;
  return {
    url: best.url,
    version: trimV(best.release.tagName),
    notes: best.release.body,
    releaseDate: parseReleaseDate(best.release.publishedAt),
  };
};

export const trimV = (tag: string) =>
  tag.startsWith("v") ? tag.slice(1) : tag;

// --- dates -------------------------------------------------------------------

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const WEEKDAYS = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

const isLeap = (year: number) =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysIn = (month: number, year: number) =>
  month === 2
    ? isLeap(year)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

type Fields = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
  // East of UTC, in minutes.
  readonly offset: number;
};

// Epoch ms for fields Go's time.Parse would accept, undefined for any it
// would reject as out of range.
const epochOf = (fields: Fields) => {
  const { year, month, day, hour, minute, second } = fields;
  if (month < 1 || month > 12 || day < 1 || day > daysIn(month, year)) {
    return undefined;
  }
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(
    hour,
    minute,
    second,
    Number(fields.fraction.padEnd(3, "0").slice(0, 3)),
  );
  return date.getTime() - fields.offset * 60_000;
};

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

// RFC 3339 as time.Parse and a time.Time's JSON both read it, in epoch ms
// (fractions past the millisecond dropped).
export const parseRfc3339 = (text: string) => {
  const match = RFC3339.exec(text);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction, sign, oh, om] =
    match;
  if (Number(oh ?? 0) > 24 || Number(om ?? 0) > 60) return undefined;
  return epochOf({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    fraction: fraction ?? "",
    offset: (sign === "-" ? -1 : 1) * (Number(oh ?? 0) * 60 + Number(om ?? 0)),
  });
};

const RFC1123 =
  /^([A-Za-z]{3}), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))? (.+)$/;

// Whether time.Parse takes a zone abbreviation. It reads each one it
// takes as UTC (GMT+3 included), but for one the local zone uses: Go
// takes that zone's offset, and this doesn't.
const isAbbreviation = (zone: string) => {
  const gmt = /^GMT([+-]\d{1,2})$/.exec(zone);
  if (gmt !== null) return Math.abs(Number(gmt[1])) <= 23;
  return /^(?:[A-Z]{3}|[A-Z]{3}T|[A-Z]{4}T|WITA|ChST|MeST)$/.test(zone);
};

// RFC 1123, with a numeric zone (RFC1123Z) or an abbreviation (RFC1123).
const parseRfc1123 = (text: string) => {
  const match = RFC1123.exec(text);
  if (match === null) return undefined;
  const [, weekday, day, month, year, hour, minute, second, fraction, zone] =
    match;
  if (!WEEKDAYS.has(weekday?.toLowerCase() ?? "")) return undefined;
  const monthIndex = MONTHS.indexOf(month?.toLowerCase() ?? "");
  if (monthIndex === -1) return undefined;
  const numeric = /^([+-])(\d{2})(\d{2})$/.exec(zone ?? "");
  const [, sign, oh, om] = numeric ?? [];
  const offset =
    numeric === null
      ? isAbbreviation(zone ?? "")
        ? 0
        : undefined
      : Number(oh) > 24 || Number(om) > 60
        ? undefined
        : (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
  if (offset === undefined) return undefined;
  return epochOf({
    year: Number(year),
    month: monthIndex + 1,
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    fraction: fraction ?? "",
    offset,
  });
};

const pad = (value: number, width = 2) =>
  String(Math.abs(value)).padStart(width, "0");

const utcDate = (date: Date) =>
  `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

// The feeds pass GitHub's date through. The formats seen in the wild are
// read, and anything else is "" rather than a failed update.
export const parseReleaseDate = (raw: string) => {
  const ms = parseRfc3339(raw) ?? parseRfc1123(raw);
  return ms === undefined ? "" : `${utcDate(new Date(ms))}Z`;
};

// A time as a time.Time marshals: RFC 3339 in UTC, the fraction without
// its trailing zeros.
export const formatTimeJson = (ms: number) => {
  const date = new Date(ms);
  const fraction = pad(date.getUTCMilliseconds(), 3).replace(/0+$/, "");
  return `${utcDate(date)}${fraction === "" ? "" : `.${fraction}`}Z`;
};

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

// An integer as strconv.ParseInt reads one: an optional sign, digits,
// and within 64 bits.
export const parseGoInt = (text: string | undefined) => {
  if (text === undefined || !/^[+-]?\d+$/.test(text)) return undefined;
  const value = BigInt(text);
  return value >= -(2n ** 63n) && value < 2n ** 63n ? value : undefined;
};

// GitHub spends the hourly budget with a 403 that says so, and 429 is its
// secondary limit. Any other 403 is a real refusal.
export const isRateLimited = (status: number, remaining: string | undefined) =>
  status === 429 || (status === 403 && remaining === "0");

const HOUR = 3_600_000;

// When the limit lifts: X-RateLimit-Reset (unix seconds), else
// Retry-After (seconds), else an hour. Never more than an hour out, so a
// bogus header can't park checks for a day.
export const rateLimitReset = (
  headers: { readonly reset?: string; readonly retryAfter?: string },
  now: number,
) => {
  const limit = now + HOUR;
  const reset = parseGoInt(headers.reset);
  if (reset !== undefined) {
    const at = Number(reset) * 1000;
    if (at > now && at < limit) return at;
  }
  const after = parseGoInt(headers.retryAfter);
  if (after !== undefined && after > 0n && after < 3600n) {
    return now + Number(after) * 1000;
  }
  return limit;
};
