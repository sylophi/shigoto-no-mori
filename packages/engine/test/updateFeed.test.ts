// The updater's pure half: picking a prerelease build's release, reading
// the feeds and the shared files as Go's encoding/json reads them, the
// dates the feeds carry, and GitHub's rate limit.
import assert from "node:assert/strict";
import * as Result from "effect/Result";
import { describe, it } from "vitest";
import { parseSemver, type Semver } from "../src/semver.ts";
import {
  decodeFeedAnswer,
  decodeReleaseList,
  decodeReleaseListCache,
  decodeStagedManifest,
  decodeUpdaterStatus,
  encodeReleaseListCache,
  encodeStagedManifest,
  formatKitchen,
  formatTimeJson,
  type GitHubRelease,
  isRateLimited,
  parseReleaseDate,
  parseRfc3339,
  pickRelease,
  rateLimitReset,
  ZERO_TIME,
} from "../src/updateFeed.ts";

const semver = (raw: string): Semver => {
  const version = parseSemver(raw);
  assert.ok(version);
  return version;
};

// A release the way GitHub lists it, with the dmg and the zip the makers
// upload for `arch`.
const labRelease = (tag: string, arch = "arm64"): GitHubRelease => {
  const version = tag.replace(/^v/, "");
  return {
    tagName: tag,
    prerelease: tag.includes("-"),
    body: `notes for ${tag}`,
    publishedAt: "2026-09-15T12:00:00Z",
    assets: [
      {
        name: `Shigoto.no.Mori-${version}-${arch}.dmg`,
        url: `https://example.test/${tag}.dmg`,
      },
      {
        name: `Shigoto.no.Mori-darwin-${arch}-${version}.zip`,
        url: `https://example.test/${tag}.zip`,
      },
    ],
  };
};

describe("pickRelease", () => {
  const current = semver("2.0.0-beta.2");
  const releases: GitHubRelease[] = [
    labRelease("v2.0.0-beta.1"),
    labRelease("v2.0.0-beta.2"),
    // Assets come minutes after the tag.
    { ...labRelease("v2.0.0-beta.9"), assets: [] },
    // Flagged prerelease on GitHub despite a full release's tag: the
    // update server hides it, and so does the picker.
    { ...labRelease("v1.9.0"), prerelease: true },
    labRelease("v2.0.0-test.keychain-prompts.1"),
    labRelease("v2.1.0-beta.1"),
    labRelease("v1.8.0"),
    labRelease("v1.7.1"),
    { ...labRelease("latest"), tagName: "latest" },
  ];
  const withAlso = (...extra: GitHubRelease[]) => [...extra, ...releases];

  it("finds nothing ahead in the channel", () => {
    assert.equal(pickRelease(current, releases, "arm64"), undefined);
  });

  it("takes the highest prerelease of the channel, whatever the order", () => {
    assert.deepEqual(
      pickRelease(
        current,
        withAlso(labRelease("v2.0.0-beta.3"), labRelease("v2.0.0-beta.4")),
        "arm64",
      ),
      {
        url: "https://example.test/v2.0.0-beta.4.zip",
        version: "2.0.0-beta.4",
        notes: "notes for v2.0.0-beta.4",
        releaseDate: "2026-09-15T12:00:00Z",
      },
    );
  });

  it("lets a full release ahead end the beta", () => {
    const picked = pickRelease(
      current,
      withAlso(labRelease("v2.0.0-beta.4"), labRelease("v2.0.0")),
      "arm64",
    );
    assert.equal(picked?.version, "2.0.0");
    // A full release past the channel's own line wins too.
    assert.equal(
      pickRelease(current, withAlso(labRelease("v2.3.1")), "arm64")?.version,
      "2.3.1",
    );
  });

  it("needs this arch's zip", () => {
    assert.equal(
      pickRelease(current, withAlso(labRelease("v2.0.0-beta.3")), "x64"),
      undefined,
    );
    const x64 = pickRelease(
      current,
      withAlso(labRelease("v2.0.0-beta.3"), labRelease("v2.0.0-beta.3", "x64")),
      "x64",
    );
    assert.equal(x64?.url, "https://example.test/v2.0.0-beta.3.zip");
    // The dmg alone, or a zip for another platform, isn't a zip for this.
    const dmgOnly = {
      ...labRelease("v2.0.0-beta.5"),
      assets: [
        { name: "Shigoto.no.Mori-darwin-arm64-2.0.0-beta.5.dmg", url: "d" },
        { name: "Shigoto.no.Mori-linux-arm64-2.0.0-beta.5.zip", url: "l" },
      ],
    };
    assert.equal(pickRelease(current, [dmgOnly], "arm64"), undefined);
  });

  it("skips a release with a lower pick even when it comes later", () => {
    const picked = pickRelease(
      current,
      [
        labRelease("v2.0.0-beta.6"),
        { ...labRelease("v2.0.0-beta.7"), assets: [] },
      ],
      "arm64",
    );
    assert.equal(picked?.version, "2.0.0-beta.6");
  });

  it("ranks a draft like any release, and passes an untagged one by", () => {
    // Drafts only reach an authenticated caller, so the flag isn't read.
    // An unpublished draft's tag is GitHub's placeholder, never a version.
    const untagged = {
      ...labRelease("v2.0.0-beta.8"),
      tagName: "untagged-4f2a9c",
    };
    assert.equal(pickRelease(current, [untagged], "arm64"), undefined);
  });

  it("moves a full release build only to full releases", () => {
    const full = semver("1.8.0");
    assert.equal(pickRelease(full, releases, "arm64"), undefined);
    assert.equal(
      pickRelease(full, withAlso(labRelease("v1.9.1")), "arm64")?.version,
      "1.9.1",
    );
  });

  it("takes the tag's v off, and keeps a date it can't read empty", () => {
    const picked = pickRelease(
      current,
      [{ ...labRelease("2.0.0-beta.3"), publishedAt: "soon" }],
      "arm64",
    );
    assert.equal(picked?.version, "2.0.0-beta.3");
    assert.equal(picked?.releaseDate, "");
  });
});

const ok = <A>(decoded: Result.Result<A, string>) => {
  assert.ok(Result.isSuccess(decoded), String(Result.getFailure(decoded)));
  return decoded.success;
};

const fails = (decoded: Result.Result<unknown, string>) =>
  assert.ok(Result.isFailure(decoded));

describe("decoding as Go does", () => {
  it("matches keys in any case, the last one winning, and skips nulls", () => {
    assert.deepEqual(
      ok(
        decodeFeedAnswer({
          URL: "https://a",
          Name: "v2.0.0",
          notes: null,
          pub_date: "x",
          PUB_DATE: "2026-09-15T12:00:00Z",
          extra: 1,
        }),
      ),
      {
        url: "https://a",
        name: "v2.0.0",
        notes: "",
        pubDate: "2026-09-15T12:00:00Z",
      },
    );
    assert.equal(ok(decodeFeedAnswer({ url: "a", URL: null })).url, "a");
    assert.deepEqual(ok(decodeFeedAnswer(null)), {
      url: "",
      name: "",
      notes: "",
      pubDate: "",
    });
  });

  it("fails on a value of the wrong type anywhere", () => {
    fails(decodeFeedAnswer({ url: 5 }));
    fails(decodeFeedAnswer([]));
    fails(decodeFeedAnswer("x"));
    fails(decodeReleaseList({}));
    fails(decodeReleaseList([{ tag_name: 1 }]));
    fails(decodeReleaseList([{ prerelease: "yes" }]));
    fails(decodeReleaseList([{ assets: {} }]));
    fails(decodeReleaseList([{ assets: [{ name: false }] }]));
    fails(decodeReleaseList([3]));
    fails(decodeUpdaterStatus({ pid: 1.5 }));
    fails(decodeUpdaterStatus({ pid: "12" }));
    fails(decodeUpdaterStatus({ state: "error" }));
  });

  it("reads null as none and keeps what it doesn't know out", () => {
    assert.deepEqual(ok(decodeReleaseList(null)), []);
    const [release] = ok(
      decodeReleaseList([
        {
          tag_name: "v1.0.0",
          prerelease: null,
          draft: true,
          assets: [null, { name: "a.zip", browser_download_url: "u", size: 3 }],
        },
        null,
      ]),
    );
    assert.deepEqual(release, {
      tagName: "v1.0.0",
      prerelease: false,
      body: "",
      publishedAt: "",
      assets: [
        { name: "", url: "" },
        { name: "a.zip", url: "u" },
      ],
    });
    assert.deepEqual(
      ok(decodeUpdaterStatus({ pid: 7, appVersion: "1.0.0", state: null })),
      { pid: 7, appVersion: "1.0.0", state: { kind: "", message: "" } },
    );
  });

  it("reads the release list copy the Go sm writes", () => {
    // As json.MarshalIndent writes it: local times to the nanosecond, the
    // zero time for no reset, and the list as raw JSON.
    const fromGo = JSON.parse(`{
  "url": "https://api.github.com/repos/sylophi/shigoto-no-mori/releases?per_page=100",
  "fetchedAt": "2026-10-08T14:03:07.123456789+02:00",
  "etag": "W/\\"abc\\"",
  "retryAt": "0001-01-01T00:00:00Z",
  "body": [
    { "tag_name": "v2.0.0-beta.3" }
  ]
}`);
    const cache = ok(decodeReleaseListCache(fromGo));
    assert.equal(cache.fetchedAt, Date.UTC(2026, 9, 8, 12, 3, 7, 123));
    assert.equal(cache.retryAt, ZERO_TIME);
    assert.equal(cache.etag, 'W/"abc"');
    assert.deepEqual(cache.body, [{ tag_name: "v2.0.0-beta.3" }]);
    // And what this writes, Go's shape again.
    assert.deepEqual(JSON.parse(encodeReleaseListCache(cache)), {
      url: fromGo.url,
      fetchedAt: "2026-10-08T12:03:07.123Z",
      etag: 'W/"abc"',
      retryAt: "0001-01-01T00:00:00Z",
      body: [{ tag_name: "v2.0.0-beta.3" }],
    });
    assert.equal(
      "etag" in JSON.parse(encodeReleaseListCache({ ...cache, etag: "" })),
      false,
    );
  });

  it("keeps a copy's null body, and tells a missing one", () => {
    assert.equal(
      ok(decodeReleaseListCache({ url: "u", body: null })).body,
      null,
    );
    assert.equal(ok(decodeReleaseListCache({ url: "u" })).body, undefined);
    fails(decodeReleaseListCache({ url: "u", fetchedAt: "yesterday" }));
  });

  it("writes the manifest the app reads, empty fields left out", () => {
    const manifest = {
      version: "2.0.0",
      bundleName: "Shigoto no Mori.app",
      notes: "",
      releaseDate: "2026-09-15T12:00:00Z",
    };
    assert.equal(
      encodeStagedManifest(manifest),
      `{\n  "version": "2.0.0",\n  "bundleName": "Shigoto no Mori.app",\n  "releaseDate": "2026-09-15T12:00:00Z"\n}\n`,
    );
    assert.deepEqual(
      ok(decodeStagedManifest(JSON.parse(encodeStagedManifest(manifest)))),
      manifest,
    );
  });
});

// A local time on one day.
const today = (hours: number, minutes: number) =>
  new Date(2026, 9, 8, hours, minutes).getTime();

describe("dates", () => {
  it("reads the formats the feeds use, in UTC to the second", () => {
    const cases: Record<string, string> = {
      "2026-09-15T12:00:00Z": "2026-09-15T12:00:00Z",
      "2026-09-15T12:00:00.987654Z": "2026-09-15T12:00:00Z",
      "2026-09-15T14:30:00+02:30": "2026-09-15T12:00:00Z",
      "2026-09-15T2:00:00Z": "2026-09-15T02:00:00Z",
      "Tue, 15 Sep 2026 12:00:00 -0700": "2026-09-15T19:00:00Z",
      "tue, 15 sep 2026 12:00:00 +0000": "2026-09-15T12:00:00Z",
      "Tue, 15 Sep 2026 12:00:00 UTC": "2026-09-15T12:00:00Z",
      "Tue, 15 Sep 2026 12:00:00 GMT": "2026-09-15T12:00:00Z",
      // The weekday isn't checked against the date, as Go doesn't.
      "Fri, 15 Sep 2026 12:00:00 GMT": "2026-09-15T12:00:00Z",
      "2024-02-29T00:00:00Z": "2024-02-29T00:00:00Z",
      "2026-02-29T00:00:00Z": "",
      "2026-13-01T00:00:00Z": "",
      "2026-09-15T24:00:00Z": "",
      "2026-09-15 12:00:00Z": "",
      "2026-09-15T12:00:00": "",
      "Tue, 15 Sep 2026 12:00:00 Moon": "",
      "": "",
      "2026-09-15T12:00:00,5Z": "2026-09-15T12:00:00Z",
      "2026-09-15t12:00:00z": "",
      "2026-09-15T12:00:00+24:00": "2026-09-14T12:00:00Z",
      "2026-09-15T12:00:00+25:00": "",
      // Go reads every abbreviation it takes as UTC, GMT+3 too.
      "Tue, 15 Sep 2026 12:00:00 GMT+3": "2026-09-15T12:00:00Z",
      "Tue, 15 Sep 2026 12:00:00 GMT+30": "",
      "Tue, 15 Sep 2026 12:00:00.5 GMT": "2026-09-15T12:00:00Z",
      "Tue, 15 Sep 2026 12:00:00 +2500": "",
      "Tue,  5 Sep 2026 12:00:00 GMT": "",
      "Tue, 5 Sep 2026 12:00:00 GMT": "",
    };
    for (const [raw, want] of Object.entries(cases)) {
      assert.equal(parseReleaseDate(raw), want, raw);
    }
  });

  it("keeps the fraction to the millisecond", () => {
    assert.equal(
      parseRfc3339("2026-09-15T12:00:00,5678Z"),
      Date.UTC(2026, 8, 15, 12, 0, 0, 567),
    );
  });

  it("writes times as time.Time marshals them", () => {
    assert.equal(formatTimeJson(ZERO_TIME), "0001-01-01T00:00:00Z");
    assert.equal(
      formatTimeJson(Date.UTC(2026, 9, 8, 12, 3, 7, 120)),
      "2026-10-08T12:03:07.12Z",
    );
  });

  it("prints the kitchen clock", () => {
    assert.equal(formatKitchen(today(0, 5)), "12:05AM");
    assert.equal(formatKitchen(today(9, 30)), "9:30AM");
    assert.equal(formatKitchen(today(12, 0)), "12:00PM");
    assert.equal(formatKitchen(today(15, 4)), "3:04PM");
  });
});

const seconds = (ms: number) => String(Math.floor(ms / 1000));

describe("GitHub's rate limit", () => {
  it("is a 429, or a 403 that says the budget is spent", () => {
    assert.equal(isRateLimited(429, undefined), true);
    assert.equal(isRateLimited(403, "0"), true);
    assert.equal(isRateLimited(403, "12"), false);
    assert.equal(isRateLimited(403, undefined), false);
    assert.equal(isRateLimited(500, "0"), false);
  });

  it("lifts at the reset, or after Retry-After, and never past an hour", () => {
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const hour = now + 3_600_000;
    const cases: ReadonlyArray<
      [{ reset?: string; retryAfter?: string }, number]
    > = [
      [{ reset: seconds(now + 1_800_000) }, now + 1_800_000],
      [{ reset: `+${seconds(now + 60_000)}` }, now + 60_000],
      // A reset in the past, or past the hour, falls to the next header.
      [{ reset: seconds(now - 1000), retryAfter: "90" }, now + 90_000],
      [{ reset: seconds(now + 7_200_000), retryAfter: "90" }, now + 90_000],
      [{ reset: seconds(hour) }, hour],
      [{ retryAfter: "3599" }, now + 3_599_000],
      [{ retryAfter: "3600" }, hour],
      [{ retryAfter: "0" }, hour],
      [{ retryAfter: " 90" }, hour],
      [{ reset: "soon", retryAfter: "1.5" }, hour],
      [{}, hour],
    ];
    for (const [headers, want] of cases) {
      assert.equal(rateLimitReset(headers, now), want, JSON.stringify(headers));
    }
  });
});
