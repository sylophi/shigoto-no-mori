// Durable proof for the villager manifest (shared/villagers/manifest.json,
// written by scripts/fetch-doubutsu-names.mts): where each doubutsu
// character's face icon lives on Nookipedia, references only.
//
// Asserts:
// - the worktree name pool (cli/embed/doubutsu-names.json) is exactly
//   the characters in the manifest, so every pickable name has a face,
//   and none of them is also listed missing
// - each entry names a wiki page and a face file of a known game's
//   kind, with its page, image URL, byte size and sha1
// - a slug two characters share takes the one on the bare-name page
// - every legendary character (shared/villagers/rarity.ts) is in the
//   pool, once
//
// Run: pnpm test villager-manifest.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGENDARY_VILLAGERS } from "@shared/villagers/rarity";
import { appRoot, makeProof, repoRoot } from "./lib/checkKit.mjs";

const proof = makeProof("villager-manifest proof");
console.log("villager-manifest proof\n");

const readJson = (...path) => JSON.parse(readFileSync(join(...path), "utf8"));
const manifest = readJson(appRoot, "shared", "villagers", "manifest.json");
// The pool is the CLI's embed, one level up from the app.
const { names } = readJson(repoRoot, "cli", "embed", "doubutsu-names.json");
const slugs = Object.keys(manifest.villagers);

// The kinds of face file the fetch script takes, by the file name's
// suffix. Only K.K. Slider's is the NH question icon.
const KINDS = [
  "NH Villager Icon",
  "PC Villager Icon",
  "NH Character Icon",
  "PC Character Icon",
  "NL Villager Icon",
  "NH Question Icon",
  "CF Character Icon",
  "HHD Character Icon",
];

try {
  await proof.check("the pool is every villager with a face", () => {
    assert.equal(names.length, 499);
    assert.deepEqual(names, slugs, "the pool and the manifest, in order");
    assert.deepEqual(slugs, slugs.toSorted(), "the manifest is sorted");
  });

  await proof.check("a character has a face or is missing, not both", () => {
    const missing = new Set(manifest.missing);
    assert.equal(missing.size, manifest.missing.length, "missing twice");
    assert.deepEqual(
      slugs.filter((slug) => missing.has(slug)),
      [],
    );
  });

  await proof.check("every entry is a complete reference", () => {
    for (const [slug, { page, icon }] of Object.entries(manifest.villagers)) {
      assert.ok(page.length > 0, `${slug}: page`);
      assert.ok(
        KINDS.some((kind) => icon.file.endsWith(` ${kind}.png`)),
        `${slug}: unknown kind of face file ${icon.file}`,
      );
      assert.ok(icon.file.startsWith("File:"), `${slug}: ${icon.file}`);
      // The file's own page, which a redirected title (Tom Nook's
      // villager icon is his character icon) resolves to.
      assert.match(
        icon.filePage,
        /^https:\/\/nookipedia\.com\/wiki\/File:.+\.png$/,
        `${slug}: file page`,
      );
      assert.match(icon.image, /^https:\/\/dodo\.ac\/np\/images\/.+\.png$/);
      assert.ok(Number.isInteger(icon.bytes) && icon.bytes > 0, slug);
      assert.match(icon.sha1, /^[0-9a-f]{40}$/, `${slug}: sha1`);
    }
    const big = slugs.filter((slug) =>
      manifest.villagers[slug].icon.file.endsWith(" NH Question Icon.png"),
    );
    assert.deepEqual(big, ["kk-slider"]);
  });

  await proof.check("a shared slug takes the bare-name page", () => {
    // Carmen the rabbit and Carmen the mouse, Lulu the hippo and Lulu
    // the anteater.
    assert.equal(manifest.villagers.carmen.page, "Carmen");
    assert.equal(
      manifest.villagers.carmen.icon.file,
      "File:Carmen NH Villager Icon.png",
    );
    // Lulu the hippo has no face, and Lulu the anteater's is not hers.
    assert.ok(manifest.missing.includes("lulu"));
  });

  await proof.check("every legendary character is in the pool, once", () => {
    for (const slug of LEGENDARY_VILLAGERS) {
      assert.ok(names.includes(slug), `${slug} is in the pool`);
    }
    assert.equal(new Set(LEGENDARY_VILLAGERS).size, LEGENDARY_VILLAGERS.length);
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
