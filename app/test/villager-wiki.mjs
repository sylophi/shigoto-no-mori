// Durable proof for the one Nookipedia reader (shared/villagers/wiki.ts)
// the name script and the app's villager data download share, against
// small wikitext fixtures shaped like the wiki's pages.
//
// Asserts:
// - an infobox reads as plain text (links, templates, notes, refs,
//   comments and line breaks), without the page styling
// - a villager's profile takes every field its page has, with the
//   birthday as MM-DD and the kind from its categories
// - a field the page lacks is left out
// - a page two characters share splits between them
// - the names rules: a disambiguated page is its bare name, slugs are
//   plain kebab-case, and a slug two characters share goes to the one
//   on the bare-name page (Carmen and Lulu)
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test villager-wiki.
import assert from "node:assert/strict";
import {
  infobox,
  namesOnPage,
  oneBySlug,
  slugify,
  villagerProfile,
  wikiPageUrl,
} from "@shared/villagers/wiki";
import { VillagerProfileSchema } from "@shared/schemas";
import { makeProof } from "./lib/checkKit.mjs";

const proof = makeProof("villager-wiki proof");
console.log("villager-wiki proof\n");

const ACE = `{{Villager Header
|species = bird
}}
{{Infobox Villager
| name = Ace
| titlecolor = #0961f6
| image = Ace amiibo.png
| caption = Artwork of Ace
| species = [[Bird]]
| personality = Jock
| gender = Male
| birthdaymonth = August
| birthday = 11
| sign = Leo
| phrase = ace<ref>In {{NH|short|nolink}}</ref>
| quote = If you love something, let it go.{{Note|A note}}<!-- hidden -->
| ja-name = フェザー
| ja-name-r = Fezā
| ko-name = N/A
}}
'''Ace''' is a jock bird villager.`;

// No catchphrase, no romaji, no birthday: the fields a page can lack.
const ISABELLE = `{{Infobox Special
| name = Isabelle
| species = Dog
| gender = Female
| sign = Sagittarius
| quote = A good attitude will always take you further.
| service = [[Town hall]] secretary<br>[[Resident Services]]
| ja-name = しずえ
}}`;

const TIMMY_AND_TOMMY = `{{Infobox Special
| name = Timmy and Tommy
| species = Raccoon
| gender = Male
| birthdaymonth = June
| birthday = 7
| quote = Experience is the best teacher.
| quote-character = Timmy
| quote2 = Nothing succeeds like success.
| quote2-character = Tommy
| ja-name = まめきち & つぶきち
}}`;

try {
  await proof.check("an infobox reads as plain text", () => {
    assert.deepEqual(infobox(ACE), {
      name: "Ace",
      species: "Bird",
      personality: "Jock",
      gender: "Male",
      birthdaymonth: "August",
      birthday: "11",
      sign: "Leo",
      phrase: "ace",
      quote: "If you love something, let it go.",
      "ja-name": "フェザー",
      "ja-name-r": "Fezā",
    });
    assert.equal(
      infobox(ISABELLE).service,
      "Town hall secretary; Resident Services",
    );
    assert.deepEqual(infobox("No infobox here."), {});
  });

  await proof.check("a villager's profile takes every field", () => {
    const profile = villagerProfile("ace", {
      title: "Ace",
      wikitext: ACE,
      categories: ["Category:Villagers"],
    });
    assert.deepEqual(profile, {
      name: "Ace",
      kind: "villager",
      species: "Bird",
      personality: "Jock",
      gender: "Male",
      birthday: "08-11",
      sign: "Leo",
      catchphrase: "ace",
      quote: "If you love something, let it go.",
      japaneseName: "フェザー",
      japaneseNameRomaji: "Fezā",
      url: "https://nookipedia.com/wiki/Ace",
    });
    assert.ok(VillagerProfileSchema.safeParse(profile).success);
  });

  await proof.check("a field the page lacks is left out", () => {
    const profile = villagerProfile("isabelle", {
      title: "Isabelle",
      wikitext: ISABELLE,
      categories: ["Category:Special characters"],
    });
    assert.deepEqual(profile, {
      name: "Isabelle",
      kind: "special",
      species: "Dog",
      gender: "Female",
      sign: "Sagittarius",
      quote: "A good attitude will always take you further.",
      japaneseName: "しずえ",
      url: "https://nookipedia.com/wiki/Isabelle",
    });
    assert.ok(!("catchphrase" in profile) && !("birthday" in profile));
    assert.ok(VillagerProfileSchema.safeParse(profile).success);
    // A page with no infobox still names the character.
    assert.deepEqual(
      villagerProfile("ace", { title: "Ace", wikitext: "", categories: [] }),
      { name: "Ace", kind: "special", url: "https://nookipedia.com/wiki/Ace" },
    );
  });

  await proof.check("a page two characters share splits between them", () => {
    const page = {
      title: "Timmy and Tommy",
      wikitext: TIMMY_AND_TOMMY,
      categories: ["Category:Special characters"],
    };
    const timmy = villagerProfile("timmy", page);
    const tommy = villagerProfile("tommy", page);
    assert.equal(timmy.name, "Timmy");
    assert.equal(tommy.name, "Tommy");
    assert.equal(timmy.japaneseName, "まめきち");
    assert.equal(tommy.japaneseName, "つぶきち");
    assert.equal(timmy.quote, "Experience is the best teacher.");
    assert.equal(tommy.quote, "Nothing succeeds like success.");
    assert.equal(timmy.birthday, "06-07");
    assert.equal(timmy.url, "https://nookipedia.com/wiki/Timmy_and_Tommy");
  });

  await proof.check("the names rules, Carmen and Lulu included", () => {
    assert.deepEqual(namesOnPage("Carmen (mouse)"), ["Carmen"]);
    assert.deepEqual(namesOnPage("Timmy and Tommy"), ["Timmy", "Tommy"]);
    assert.equal(slugify("K.K. Slider"), "kk-slider");
    assert.equal(slugify("Renée"), "renee");
    assert.equal(slugify("Zipper T. Bunny"), "zipper-t-bunny");
    assert.equal(
      wikiPageUrl("Carmen (mouse)"),
      "https://nookipedia.com/wiki/Carmen_(mouse)",
    );
    const characters = [
      { slug: "carmen", name: "Carmen", page: "Carmen (mouse)" },
      { slug: "carmen", name: "Carmen", page: "Carmen" },
      { slug: "lulu", name: "Lulu", page: "Lulu" },
      { slug: "lulu", name: "Lulu", page: "Lulu (anteater)" },
      { slug: "ace", name: "Ace", page: "Ace" },
    ];
    const bySlug = oneBySlug(characters);
    assert.deepEqual([...bySlug.keys()], ["carmen", "lulu", "ace"]);
    assert.equal(bySlug.get("carmen").page, "Carmen");
    assert.equal(bySlug.get("lulu").page, "Lulu");
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
