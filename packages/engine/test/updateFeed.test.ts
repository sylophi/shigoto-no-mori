// The updater's pure half: picking a prerelease build's release, the
// release list as GitHub sends it, the dates the feeds carry, and
// GitHub's rate limit.
import assert from "node:assert/strict";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import { parseSemver, type Semver } from "../src/semver.ts";
import {
  formatKitchen,
  isRateLimited,
  parseReleaseDate,
  pickRelease,
  rateLimitReset,
  ReleaseList,
} from "../src/updateFeed.ts";

type Release = NonNullable<NonNullable<typeof ReleaseList.Type>[number]>;

const semver = (raw: string): Semver => {
  const version = parseSemver(raw);
  assert.ok(version);
  return version;
};

// A release the way GitHub lists it, with the dmg and the zip the makers
// upload for `arch`.
const labRelease = (tag: string, arch = "arm64"): Release => {
  const version = tag.replace(/^v/, "");
  return {
    tag_name: tag,
    prerelease: tag.includes("-"),
    body: `notes for ${tag}`,
    published_at: "2026-09-15T12:00:00Z",
    assets: [
      {
        name: `Shigoto.no.Mori-${version}-${arch}.dmg`,
        browser_download_url: `https://example.test/${tag}.dmg`,
      },
      {
        name: `Shigoto.no.Mori-darwin-${arch}-${version}.zip`,
        browser_download_url: `https://example.test/${tag}.zip`,
      },
    ],
  };
};

describe("pickRelease", () => {
  const current = semver("2.0.0-beta.2");
  const releases: Release[] = [
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
    { ...labRelease("latest"), tag_name: "latest" },
  ];
  const withAlso = (...extra: Release[]) => [...extra, ...releases];

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
        {
          name: "Shigoto.no.Mori-darwin-arm64-2.0.0-beta.5.dmg",
          browser_download_url: "d",
        },
        {
          name: "Shigoto.no.Mori-linux-arm64-2.0.0-beta.5.zip",
          browser_download_url: "l",
        },
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

  it("passes an unpublished draft by", () => {
    // Its tag is GitHub's placeholder, never a version.
    const untagged = {
      ...labRelease("v2.0.0-beta.8"),
      tag_name: "untagged-4f2a9c",
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

  it("reads what is null or missing as Go's zero values", () => {
    const sparse = [
      null,
      { tag_name: "v2.0.0-beta.4" },
      {
        tag_name: "v2.0.0-beta.3",
        prerelease: null,
        assets: [
          null,
          {
            name: "Shigoto.no.Mori-darwin-arm64-2.0.0-beta.3.zip",
            browser_download_url: "z",
          },
        ],
      },
    ];
    const decoded = Schema.decodeUnknownOption(ReleaseList)(sparse);
    assert.ok(Option.isSome(decoded));
    assert.deepEqual(pickRelease(current, decoded.value ?? [], "arm64"), {
      url: "z",
      version: "2.0.0-beta.3",
      notes: "",
      releaseDate: "",
    });
  });

  it("reads GitHub's nulls as empty", () => {
    const picked = pickRelease(
      current,
      [{ ...labRelease("2.0.0-beta.3"), body: null, published_at: null }],
      "arm64",
    );
    assert.deepEqual(picked, {
      url: "https://example.test/2.0.0-beta.3.zip",
      version: "2.0.0-beta.3",
      notes: "",
      releaseDate: "",
    });
  });
});

describe("the release list as GitHub sends it", () => {
  const decode = Schema.decodeUnknownOption(ReleaseList);

  it("ignores the fields the picker doesn't read", () => {
    const decoded = decode([
      {
        ...labRelease("v1.0.0"),
        body: null,
        draft: false,
        assets: [{ name: "a.zip", browser_download_url: "u", size: 3 }],
      },
    ]);
    assert.ok(Option.isSome(decoded));
    assert.deepEqual(decoded.value?.[0]?.assets, [
      { name: "a.zip", browser_download_url: "u" },
    ]);
  });

  it("reads a null list as an empty one", () => {
    assert.deepEqual(decode(null), Option.some(null));
  });

  it("refuses a value of the wrong type", () => {
    assert.ok(Option.isNone(decode({})));
    assert.ok(
      Option.isNone(decode([{ ...labRelease("v1.0.0"), tag_name: 1 }])),
    );
    assert.ok(
      Option.isNone(decode([{ ...labRelease("v1.0.0"), prerelease: "yes" }])),
    );
  });
});

// A local time on one day.
const today = (hours: number, minutes: number) =>
  new Date(2026, 9, 8, hours, minutes).getTime();

describe("dates", () => {
  it("reads RFC 3339 and RFC 1123, in UTC to the second", () => {
    const cases: Record<string, string> = {
      "2026-09-15T12:00:00Z": "2026-09-15T12:00:00Z",
      "2026-09-15T12:00:00.987654Z": "2026-09-15T12:00:00Z",
      "2026-09-15T14:30:00+02:30": "2026-09-15T12:00:00Z",
      "Tue, 15 Sep 2026 12:00:00 -0700": "2026-09-15T19:00:00Z",
      "Tue, 15 Sep 2026 12:00:00 +0530": "2026-09-15T06:30:00Z",
      "Tue, 15 Sep 2026 12:00:00 GMT": "2026-09-15T12:00:00Z",
      "Tue, 15 Sep 2026 12:00:00 UTC": "2026-09-15T12:00:00Z",
      // Go reads an abbreviation it doesn't know as UTC too.
      "Tue, 15 Sep 2026 12:00:00 EST": "2026-09-15T12:00:00Z",
      "Tue, 15 Spt 2026 12:00:00 GMT": "",
      "15 Sep 2026 12:00:00 GMT": "",
      "2026-09-15 12:00:00Z": "",
      "2026-09-15T12:00:00": "",
      "": "",
    };
    for (const [raw, want] of Object.entries(cases)) {
      assert.equal(parseReleaseDate(raw), want, raw);
    }
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
      // A reset in the past, or past the hour, falls to the next header.
      [{ reset: seconds(now - 1000), retryAfter: "90" }, now + 90_000],
      [{ reset: seconds(now + 7_200_000), retryAfter: "90" }, now + 90_000],
      [{ reset: seconds(hour) }, hour],
      [{ retryAfter: "3599" }, now + 3_599_000],
      [{ retryAfter: "3600" }, hour],
      [{ retryAfter: "0" }, hour],
      [{ reset: "soon", retryAfter: "1.5" }, hour],
      [{}, hour],
    ];
    for (const [headers, want] of cases) {
      assert.equal(rateLimitReset(headers, now), want, JSON.stringify(headers));
    }
  });
});
