// What the committed dmg artwork was rendered from, as one hash. The
// renderer (scripts/build-dmg-background.cjs) stamps it next to the art
// and test/dmg-art.mjs compares the two, so both read it from here.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DMG_ART_DIR,
  dmgBackgroundName,
} from "../../shared/packaging/dmgLayout.mts";

const ROOT = join(import.meta.dirname, "..", "..");

// The design the pixels are rendered from: the stylesheet the art is
// drawn with, the art itself, the geometry both it and the maker read,
// and the webfont package (a bump reshapes every glyph in the window).
// Not the render script, since editing that means running it.
const INPUT_FILES = [
  "renderer/doubutsu.css",
  "scripts/dmg-background.html",
  "shared/packaging/dmgLayout.mts",
];
const FONT_PACKAGE = "node_modules/@fontsource/zen-maru-gothic/package.json";

// The rendered art itself is hashed too, so a twin that goes missing or
// gets reverted fails here rather than at someone's retina download,
// since appdmg falls back to the 1x image without complaining.
export const ART_FILES = [false, true].flatMap((prerelease) =>
  [1, 2].map(
    (scale) => `${DMG_ART_DIR}/${dmgBackgroundName(prerelease, scale)}`,
  ),
);

export const ART_STAMP_FILE = join(ROOT, DMG_ART_DIR, "inputs.sha256");

// A design input with its comments removed, so rewording one (a moved
// file's path, a renamed check) does not read as a design change and
// send someone off to re-render identical pixels. Deliberately narrow,
// per file type, and never `//` to end of line: the stylesheet carries
// SVG data URIs whose xmlns holds a `//`, and dropping the rest of that
// line would hide a real wallpaper edit.
function withoutComments(file, src) {
  if (file.endsWith(".css")) return src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (file.endsWith(".html")) return src.replace(/<!--[\s\S]*?-->/g, "");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*\n/gm, "");
}

export function artInputsHash() {
  const hash = createHash("sha256");
  for (const file of INPUT_FILES) {
    hash.update(withoutComments(file, readFileSync(join(ROOT, file), "utf8")));
  }
  for (const file of ART_FILES) {
    hash.update(readFileSync(join(ROOT, file)));
  }
  const font = join(ROOT, FONT_PACKAGE);
  hash.update(
    existsSync(font) ? JSON.parse(readFileSync(font, "utf8")).version : "",
  );
  return hash.digest("hex");
}
