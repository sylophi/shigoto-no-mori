// Durable proof for the changelog's read of the GitHub releases
// (shared/releases.ts).
//
// Asserts: tags order as semver, prereleases included. A device's
// changelog lists newest first whatever GitHub's order, with
// prereleases only on the beta ride. An update brings the releases
// after the build up to it, and only a move up is an update. The fetch
// keeps drafts out and names GitHub's refusals.
// Run: pnpm test changelog.
import assert from "node:assert/strict";
import {
  changelogFor,
  compareVersions,
  fetchReleases,
  isBetween,
  releaseVersionOf,
  updatedFrom,
} from "@shared/releases";
import type { Release } from "@shigomori/contracts/schemas";
import { it } from "vitest";

const release = (version: string, prerelease = false): Release => ({
  version,
  notes: `notes for ${version}`,
  publishedAt: null,
  prerelease,
  url: `https://github.com/o/r/releases/tag/v${version}`,
});

// GitHub's order (the tagged commit's date), deliberately not the
// versions': the beta was cut from an older commit.
const releases = [
  release("2.15.0"),
  release("2.14.2"),
  release("2.16.0-beta.1", true),
  release("2.14.1"),
  release("2.14.0"),
];

const listed = (installed: string, staged: string | null) =>
  changelogFor(releases, installed, staged).map((entry) => entry.version);

const response = (status: number, body: unknown, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

it("versions order as semver, prereleases below", () => {
  const sorted = [
    "2.10.0",
    "v2.9.1",
    "2.10.0-beta.2",
    "2.10.0-beta.10",
    "2.10.0-alpha",
    "2.10.0-beta",
    "nightly",
  ].toSorted(compareVersions);
  assert.deepEqual(sorted, [
    "nightly",
    "v2.9.1",
    "2.10.0-alpha",
    "2.10.0-beta",
    "2.10.0-beta.2",
    "2.10.0-beta.10",
    "2.10.0",
  ]);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
});

it("the changelog is newest first", () => {
  assert.deepEqual(listed("2.14.1", null), [
    "2.15.0",
    "2.14.2",
    "2.14.1",
    "2.14.0",
  ]);
});

it("a tag counts as its version, and a dev build as none", () => {
  assert.equal(releaseVersionOf("v2.14.1"), "2.14.1");
  assert.equal(releaseVersionOf("2.14.1"), "2.14.1");
  assert.equal(releaseVersionOf("dev"), "");
  assert.equal(releaseVersionOf("unknown"), "");
  assert.ok(listed("v2.16.0-beta.1", null).includes("2.16.0-beta.1"));
});

it("prereleases show only on the beta ride", () => {
  assert.ok(!listed("2.15.0", null).includes("2.16.0-beta.1"));
  assert.ok(!listed("dev", null).includes("2.16.0-beta.1"));
  assert.deepEqual(listed("2.16.0-beta.1", null).slice(0, 2), [
    "2.16.0-beta.1",
    "2.15.0",
  ]);
  // Staged, it shows whatever the build runs.
  assert.equal(listed("2.15.0", "2.16.0-beta.1")[0], "2.16.0-beta.1");
});

it("an update brings the releases after it, up to the new one", () => {
  const brought = (from: string, to: string) =>
    releases
      .map((r) => r.version)
      .filter((version) => isBetween(version, from, to));
  assert.deepEqual(brought("2.14.0", "2.14.2"), ["2.14.2", "2.14.1"]);
  assert.deepEqual(brought("", "2.15.0"), ["2.15.0"]);
  assert.deepEqual(brought("2.15.0", "2.15.0"), []);
});

it("only a move up to a newer release is an update", () => {
  assert.equal(updatedFrom("2.14.2", "v2.15.0"), "2.14.2");
  assert.equal(updatedFrom("v2.14.2", "2.15.0"), "2.14.2");
  // A first run, the same build again, a downgrade, a dev build.
  assert.equal(updatedFrom(null, "2.15.0"), null);
  assert.equal(updatedFrom("2.15.0", "2.15.0"), null);
  assert.equal(updatedFrom("2.15.0", "2.14.2"), null);
  assert.equal(updatedFrom("2.15.0", "dev"), null);
  assert.equal(updatedFrom("dev", "2.15.0"), null);
});

it("the fetch maps the list and drops drafts", async () => {
  const list = await fetchReleases(async () =>
    response(200, [
      {
        tag_name: "v2.15.0",
        body: "**hello**",
        published_at: "2026-09-27T20:38:34Z",
        prerelease: false,
        html_url: "https://github.com/o/r/releases/tag/v2.15.0",
        assets: [],
      },
      {
        tag_name: "v2.16.0",
        body: null,
        published_at: null,
        prerelease: false,
        draft: true,
        html_url: "https://github.com/o/r/releases/tag/untagged",
      },
    ]),
  );
  assert.deepEqual(list, [
    {
      version: "2.15.0",
      notes: "**hello**",
      publishedAt: "2026-09-27T20:38:34Z",
      prerelease: false,
      url: "https://github.com/o/r/releases/tag/v2.15.0",
    },
  ]);
});

it("GitHub's refusals come back as sentences", async () => {
  await assert.rejects(
    fetchReleases(async () =>
      response(403, {}, { "x-ratelimit-remaining": "0" }),
    ),
    /rate-limiting/,
  );
  await assert.rejects(
    fetchReleases(async () => response(502, {})),
    /HTTP 502/,
  );
  await assert.rejects(
    fetchReleases(async () => response(200, { message: "nope" })),
    /can't read/,
  );
  await assert.rejects(
    fetchReleases(() => Promise.reject(new TypeError("fetch failed"))),
    /Couldn't reach GitHub/,
  );
});
