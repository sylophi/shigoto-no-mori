// Verifies the committed dmg artwork isn't older than the design it was
// rendered from. The art in assets/dmg/ is generated (see
// scripts/build-dmg-background.cjs) but committed, so `make` never has
// to run a browser -- the tradeoff is that a doubutsu palette edit can
// land, pass every other check, and still ship an installer window
// wearing the previous release's colors. Nothing about a png says how
// old it is, so the renderer stamps a hash of its inputs next to it and
// this compares the two. Same shape as licenses:check.
//
// Run by lefthook pre-commit, and by hand as `pnpm dmg:check`.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DMG_ART_DIR, dmgBackgroundName } from "../shared/dmgLayout.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The design the pixels are rendered from: the stylesheet the art is
// drawn with, the art itself, the geometry both it and the maker read,
// and the webfont package (a bump reshapes every glyph in the window).
// Not the render script -- editing that means running it.
const INPUT_FILES = [
  "renderer/doubutsu.css",
  "scripts/dmg-background.html",
  "shared/dmgLayout.mts",
];
const FONT_PACKAGE = "node_modules/@fontsource/zen-maru-gothic/package.json";

// The rendered art itself is hashed too, so a twin that goes missing or
// gets reverted fails here rather than at someone's retina download --
// appdmg falls back to the 1x image without complaining.
const ART_FILES = [false, true].flatMap((prerelease) =>
  [1, 2].map(
    (scale) => `${DMG_ART_DIR}/${dmgBackgroundName(prerelease, scale)}`,
  ),
);

export const ART_STAMP_FILE = join(ROOT, DMG_ART_DIR, "inputs.sha256");

export function artInputsHash() {
  const hash = createHash("sha256");
  for (const file of [...INPUT_FILES, ...ART_FILES]) {
    hash.update(readFileSync(join(ROOT, file)));
  }
  const font = join(ROOT, FONT_PACKAGE);
  hash.update(
    existsSync(font) ? JSON.parse(readFileSync(font, "utf8")).version : "",
  );
  return hash.digest("hex");
}

function check() {
  const missing = ART_FILES.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length > 0) {
    fail(
      `the installer artwork is incomplete -- missing ${missing.join(", ")}.`,
    );
  }
  const stamped = existsSync(ART_STAMP_FILE)
    ? readFileSync(ART_STAMP_FILE, "utf8").trim()
    : null;
  if (stamped === artInputsHash()) {
    console.log("dmg art OK");
    return;
  }
  fail(
    stamped === null
      ? `no stamp at ${DMG_ART_DIR}/inputs.sha256.`
      : "the installer artwork predates a change to the design it is rendered from.",
  );
}

function fail(reason) {
  console.error(`Dmg art check failed: ${reason}`);
  console.error(
    "\nRe-render it with `pnpm dmg:background` and commit the result.",
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  check();
}
