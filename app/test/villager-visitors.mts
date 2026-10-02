// Durable proof for the Visitors album's model
// (renderer/lib/villagers/visitors.ts).
//
// Asserts:
// - every device's tally adds up into one, by villager
// - the album holds a slot for every character, by rarity, and leaves
//   out a tally entry no profile knows
// - visited come first in the sort's order, the empty slots after
// - one best friend, the villager met most, and the newest face
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test villager-visitors.
import assert from "node:assert/strict";
import type { VillagerProfiles } from "@shared/schemas";
import {
  bestFriendOf,
  buildAlbum,
  mergeTallies,
  sortAlbum,
} from "@/lib/villagers/visitors";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("villager-visitors proof");
console.log("villager-visitors proof\n");

const now = 1_000_000;

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

const merged = mergeTallies([
  {
    deviceId: "a",
    label: "Studio Mac",
    tally: {
      raymond: { count: 3, first: 100, last: now - 500 },
      ace: { count: 1, first: now, last: now },
      ghost: { count: 9, first: 1, last: 2 },
    },
  },
  {
    deviceId: "b",
    label: "Thinkpad",
    tally: {
      raymond: { count: 5, first: 50, last: now },
      "tom-nook": { count: 1, first: 300, last: 300 },
    },
  },
]);

try {
  await proof.check("tallies add up across devices", () => {
    assert.deepEqual(merged.get("raymond"), {
      count: 8,
      first: 50,
      last: now,
      byDevice: [
        { deviceId: "b", label: "Thinkpad", count: 5 },
        { deviceId: "a", label: "Studio Mac", count: 3 },
      ],
    });
    assert.equal(merged.get("ace")?.byDevice.length, 1);
  });

  const album = buildAlbum(profiles, merged);

  await proof.check("the album has a slot for every character", () => {
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
    assert.equal(album.visited.length, 3);
    assert.equal(album.visits, 10);
  });

  await proof.check("visited come first, in the sort's order", () => {
    const order = (sort: "visits" | "recent" | "name") =>
      sortAlbum(album.sections.common, sort).map((entry) => entry.slug);
    assert.deepEqual(order("visits"), ["raymond", "ace", "bob"]);
    assert.deepEqual(order("name"), ["ace", "raymond", "bob"]);
  });

  await proof.check("one best friend, the villager met most", () => {
    assert.equal(album.bestFriend?.slug, "raymond");
    assert.equal(album.newest?.slug, "ace");
    assert.deepEqual(album.met, { legendary: 1, rare: 0, common: 2 });
    assert.equal(bestFriendOf([]), null);
    // Met as often: the one seen last.
    const tied = buildAlbum(
      profiles,
      mergeTallies([
        {
          deviceId: "a",
          label: "a",
          tally: {
            ace: { count: 2, first: 0, last: 0 },
            bob: { count: 2, first: 0, last: now },
          },
        },
      ]),
    );
    assert.equal(tied.bestFriend?.slug, "bob");
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
