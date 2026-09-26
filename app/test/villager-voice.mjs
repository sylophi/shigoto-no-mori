// Durable proof for the villager voice (renderer/lib/villagerVoice.ts):
// what a villager says in a toast, and the news when villagers move in
// or out, whoever moved them.
//
// Asserts:
// - a worktree speaks for the character it is named after, a numbered
//   one (sheldon-2) too, and any other name has no speaker
// - rarity: regular villagers common, special characters rare, the
//   household names legendary
// - a catchphrase ends the message in its own casing, takes the
//   sentence's end, and is left out in another script or when missing
// - moves are read by worktree id, and the primary checkout never counts
// - a common villager's news is their catchphrase, a rare or legendary
//   one's is their quote (or the move in their own words), and the
//   rarest sets how long it stays
// - several moving at once share one line, a numbered twin counts once,
//   and a move on another device names it
// - a rare or legendary one in a crowd keeps their own moment
// - moves net out one for one by project and name (a relocate is none)
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test villager-voice.
import assert from "node:assert/strict";
import { villagerRarity } from "@shared/villagers/rarity";
import {
  MOVE_TOAST_MS,
  moveNews,
  moveNewsFor,
  netMoves,
  rarest,
  speakerFor,
  speakerSlug,
  villagerLine,
  worktreeMoves,
} from "@/lib/villagerVoice";
import { makeProof } from "./lib/checkKit.mjs";

const proof = makeProof("villager-voice proof");
console.log("villager-voice proof\n");

const PROFILES = {
  raymond: {
    name: "Raymond",
    kind: "villager",
    gender: "Male",
    catchphrase: "crisp",
    quote: "Stay on brand!",
    url: "",
  },
  sheldon: {
    name: "Sheldon",
    kind: "villager",
    gender: "Male",
    catchphrase: "cardio",
    quote: "Winners don't quit, and quitters never win.",
    url: "",
  },
  bianca: {
    name: "Bianca",
    kind: "villager",
    gender: "Female",
    catchphrase: "glimmer…",
    url: "",
  },
  cephalobot: {
    name: "Cephalobot",
    kind: "villager",
    catchphrase: "ピコピコ",
    url: "",
  },
  katrina: {
    name: "Katrina",
    kind: "special",
    gender: "Female",
    quote: "Bad luck is just luck that is bad.",
    url: "",
  },
  pelly: { name: "Pelly", kind: "special", gender: "Female", url: "" },
  "tom-nook": {
    name: "Tom Nook",
    kind: "special",
    gender: "Male",
    quote: "I'll be there with Bells on! Ho ho!",
    url: "",
  },
};

const speaker = (name) => ({
  ...speakerFor(name, PROFILES),
  face: null,
  color: null,
});

let serial = 0;
const worktree = (name, extra = {}) => ({
  id: `wt${++serial}`,
  name,
  branch: `feat/${name}`,
  detached: false,
  mergedIntoPrimary: false,
  isPrimary: false,
  ...extra,
});

const speakersOf = (worktrees) =>
  new Map(
    worktrees.flatMap((w) =>
      speakerFor(w.name, PROFILES) === null ? [] : [[w.id, speaker(w.name)]],
    ),
  );

try {
  await proof.check("a worktree speaks for its character", () => {
    assert.equal(speakerSlug("raymond", PROFILES), "raymond");
    assert.equal(speakerSlug("raymond-2", PROFILES), "raymond");
    assert.equal(speakerSlug("tom-nook", PROFILES), "tom-nook");
    assert.equal(speakerSlug("tom-nook-3", PROFILES), "tom-nook");
    assert.equal(speakerSlug("snug-otter", PROFILES), null);
    assert.equal(speakerSlug("raymond-x", PROFILES), null);
    // A slug that is an Object key, not a character.
    assert.equal(speakerSlug("constructor", PROFILES), null);
  });

  await proof.check("rarity follows the character", () => {
    assert.equal(villagerRarity("raymond", { kind: "villager" }), "common");
    assert.equal(villagerRarity("katrina", { kind: "special" }), "rare");
    assert.equal(villagerRarity("tom-nook", { kind: "special" }), "legendary");
    assert.equal(speaker("tom-nook-2").rarity, "legendary");
    assert.equal(rarest([speaker("raymond"), speaker("katrina")]), "rare");
    assert.equal(
      rarest([speaker("tom-nook"), speaker("katrina")]),
      "legendary",
    );
    assert.ok(MOVE_TOAST_MS.common < MOVE_TOAST_MS.rare);
    assert.ok(MOVE_TOAST_MS.rare < MOVE_TOAST_MS.legendary);
  });

  await proof.check("a catchphrase ends the sentence", () => {
    assert.deepEqual(villagerLine(speaker("sheldon"), "Committed 3f2a1b"), {
      lead: "Committed 3f2a1b",
      tail: ", cardio!",
      speaker: "Sheldon",
    });
    // The message's own period goes, a question keeps its mark.
    assert.equal(
      villagerLine(speaker("raymond"), "Changes restored.").lead,
      "Changes restored",
    );
    assert.equal(villagerLine(speaker("raymond"), "Ready?").tail, ", crisp?");
    // One that closes itself takes no second mark.
    assert.equal(villagerLine(speaker("bianca"), "Done").tail, ", glimmer…");
    // Another script, or none at all, stays plain.
    assert.equal(villagerLine(speaker("cephalobot"), "Done"), null);
    assert.equal(villagerLine(speaker("katrina"), "Done"), null);
  });

  await proof.check("moves are read by id, never the primary", () => {
    const primary = worktree("shigoto-no-mori", { isPrimary: true });
    const kept = worktree("raymond");
    const gone = worktree("sheldon");
    const renamed = { ...kept, name: "raymond-renamed" };
    const came = worktree("katrina");
    assert.deepEqual(worktreeMoves([primary, kept, gone], [kept, came]), {
      movedIn: [came],
      movedOut: [gone],
    });
    // Same id, new name: nobody moved.
    assert.deepEqual(worktreeMoves([kept], [renamed]), {
      movedIn: [],
      movedOut: [],
    });
  });

  await proof.check("the news scales with rarity", () => {
    const raymond = worktree("raymond");
    const common = moveNews("in", [raymond], speakersOf([raymond]));
    assert.equal(common.title, "Raymond moved in");
    assert.equal(common.line.tail, ", crisp!");
    assert.equal(common.words, null);
    assert.equal(common.detail, "Holding");
    assert.equal(common.branch, "feat/raymond");
    assert.equal(common.rarity, "common");

    const katrina = worktree("katrina", { mergedIntoPrimary: true });
    const rare = moveNews("out", [katrina], speakersOf([katrina]));
    assert.equal(rare.title, "Katrina moved out");
    assert.equal(rare.line, null);
    assert.equal(rare.words, "Bad luck is just luck that is bad.");
    assert.equal(rare.detail, "Landed");
    assert.equal(rare.rarity, "rare");

    const nook = worktree("tom-nook", { detached: true });
    const legend = moveNews("in", [nook], speakersOf([nook]));
    assert.equal(legend.words, "I'll be there with Bells on! Ho ho!");
    // One with no quote says the move in their own words.
    const quiet = worktree("pelly");
    const pelly = moveNews("out", [quiet], speakersOf([quiet]));
    assert.equal(pelly.words, "I'm moving out!");
    assert.equal(legend.detail, null);
    assert.equal(legend.rarity, "legendary");
  });

  await proof.check("several at once, twins, devices, strangers", () => {
    const four = ["raymond", "sheldon", "katrina", "tom-nook"].map((name) =>
      worktree(name, { mergedIntoPrimary: name !== "sheldon" }),
    );
    const out = moveNews("out", four, speakersOf(four));
    assert.equal(out.title, "Raymond, Sheldon and 2 others moved out");
    assert.equal(out.detail, "Landed 3 of 4 branches");
    assert.equal(out.words, null);
    assert.equal(out.rarity, "legendary");
    assert.equal(out.speakers.length, 4);

    // Twins are one villager talking.
    const twins = [worktree("raymond"), worktree("raymond-2")];
    const both = moveNews("in", twins, speakersOf(twins));
    assert.equal(both.title, "Raymond moved in");
    assert.equal(both.line.tail, ", crisp!");
    assert.equal(both.speakers.length, 1);

    const pair = [worktree("raymond"), worktree("katrina")];
    assert.equal(
      moveNews("in", pair, speakersOf(pair), "Thinkpad").title,
      "Raymond and Katrina moved in on Thinkpad",
    );

    // Strangers aren't news, and don't join a villager's.
    const stranger = worktree("snug-otter");
    assert.equal(moveNews("out", [stranger], speakersOf([stranger])), null);
    const mixed = [stranger, worktree("sheldon")];
    assert.equal(
      moveNews("out", mixed, speakersOf(mixed)).line.lead,
      "Sheldon moved out",
    );
  });

  await proof.check(
    "a rare or legendary one keeps their moment in a crowd",
    () => {
      const crowd = [
        "raymond",
        "sheldon",
        "katrina",
        "tom-nook",
        "tom-nook-2",
      ].map((name) => worktree(name));
      const news = moveNewsFor("in", crowd, speakersOf(crowd));
      assert.deepEqual(
        news.map((n) => n.title),
        [
          "Raymond and Sheldon moved in",
          "Katrina moved in",
          "Tom Nook moved in",
        ],
      );
      // Tom Nook's twins are his one letter, shown last, on top.
      assert.equal(news[2].worktreeIds.length, 2);
      assert.equal(news[2].words, "I'll be there with Bells on! Ho ho!");
      // Only regulars, or only one special: one news.
      assert.equal(
        moveNewsFor("in", crowd.slice(0, 2), speakersOf(crowd)).length,
        1,
      );
      assert.deepEqual(
        moveNewsFor("in", [worktree("snug-otter")], new Map()),
        [],
      );
    },
  );

  await proof.check("moves net out one for one, by project and name", () => {
    const w = (
      name,
      projectId = "p1",
      id = `${projectId}:${name}:${++serial}`,
    ) => worktree(name, { projectId, id });
    // Relocated: same name, new id, same project. Not a move.
    const relocated = netMoves([w("raymond")], [w("raymond")]);
    assert.deepEqual(relocated, { movedIn: [], movedOut: [] });
    // Same name in two projects: both real.
    const across = netMoves([w("sheldon", "p2")], [w("sheldon", "p1")]);
    assert.equal(across.movedIn.length, 1);
    assert.equal(across.movedOut.length, 1);
    // Added, removed and added again: one arrival left.
    const again = netMoves([w("lucha"), w("lucha")], [w("lucha")]);
    assert.equal(again.movedIn.length, 1);
    assert.equal(again.movedOut.length, 0);
  });

  await proof.check("one landed branch among several villagers", () => {
    const pair = [
      worktree("raymond", { detached: true }),
      worktree("sheldon", { mergedIntoPrimary: true }),
    ];
    assert.equal(
      moveNews("out", pair, speakersOf(pair)).detail,
      "Landed their branch",
    );
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
