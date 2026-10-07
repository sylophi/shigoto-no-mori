// Durable proof for the Visitors album's model
// (renderer/lib/villagers/visitors.ts).
//
// Asserts:
// - the visit log tallies by villager, leaving out a mirror's copy, and
//   from a reset on, only visits made since
// - the album holds a slot for every character, by rarity, and leaves
//   out a visit by a name no profile knows
// - visited come first in the sort's order, the empty slots after
// - one best friend, the villager met most, and the newest face
//
// Run: pnpm test villager-visitors.
import assert from "node:assert/strict";
import type { VillagerProfiles } from "@shared/schemas";
import { buildAlbum, sortAlbum, tallyVisits } from "@/lib/villagers/visitors";
import { it } from "vitest";

const profile = (name: string, kind: "villager" | "special" = "villager") => ({
  name,
  kind,
  url: `https://nookipedia.com/wiki/${name}`,
});
const profiles: VillagerProfiles = {
  raymond: profile("Raymond"),
  ace: profile("Ace"),
  bob: profile("Bob"),
  katrina: profile("Katrina", "special"),
  "tom-nook": profile("Tom Nook", "special"),
};

const tally = tallyVisits({
  "mac:w1:100": { slug: "raymond", at: 100 },
  "mac:w2:500": { slug: "raymond", at: 500 },
  "pad:w3:300": { slug: "raymond", at: 300 },
  // A transplant's copy: seen, not a visit.
  "pad:w4:600": null,
  "mac:w5:900": { slug: "ace", at: 900 },
  "mac:w6:200": { slug: "tom-nook", at: 200 },
  "mac:w7:50": { slug: "ghost", at: 50 },
});

it("the log tallies by villager", () => {
  assert.deepEqual(tally.get("raymond"), { count: 3, first: 100, last: 500 });
  assert.deepEqual(tally.get("ace"), { count: 1, first: 900, last: 900 });
  assert.equal(tally.size, 4);
});

it("a reset counts only visits made since", () => {
  const since = tallyVisits(
    {
      "mac:w1:100": { slug: "raymond", at: 100 },
      "mac:w2:500": { slug: "raymond", at: 500 },
      "mac:w5:900": { slug: "ace", at: 900 },
      "pad:w4:600": null,
    },
    500,
  );
  assert.deepEqual(since.get("raymond"), { count: 1, first: 500, last: 500 });
  assert.equal(since.size, 2);
});

const album = buildAlbum(profiles, tally);

it("the album has a slot for every character", () => {
  assert.equal(album.total, 5);
  assert.deepEqual(
    album.sections.legendary.map((entry) => entry.slug),
    ["tom-nook"],
  );
  assert.deepEqual(
    album.sections.rare.map((entry) => entry.slug),
    ["katrina"],
  );
  assert.equal(album.sections.common.length, 3);
  // ghost has no profile: no slot, and its visits don't count.
  assert.equal(album.metTotal, 3);
  assert.equal(album.visits, 5);
  assert.deepEqual(album.met, { legendary: 1, rare: 0, common: 2 });
});

it("visited come first, in the sort's order", () => {
  const order = (sort: "visits" | "recent" | "name") =>
    sortAlbum(album.sections.common, sort).map((entry) => entry.slug);
  assert.deepEqual(order("visits"), ["raymond", "ace", "bob"]);
  assert.deepEqual(order("recent"), ["ace", "raymond", "bob"]);
  assert.deepEqual(order("name"), ["ace", "raymond", "bob"]);
});

it("one best friend, the villager met most", () => {
  assert.equal(album.bestFriend?.slug, "raymond");
  assert.equal(album.newest?.slug, "ace");
  assert.equal(buildAlbum(profiles, new Map()).bestFriend, null);
  // Met as often: the one seen last.
  const tied = buildAlbum(
    profiles,
    tallyVisits({
      a: { slug: "ace", at: 1 },
      b: { slug: "bob", at: 2 },
    }),
  );
  assert.equal(tied.bestFriend?.slug, "bob");
});
