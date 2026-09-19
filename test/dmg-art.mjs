// Verifies the committed dmg artwork isn't older than the design it was
// rendered from. The art in assets/dmg/ is generated (see
// scripts/build-dmg-background.cjs) but committed, so `make` never has
// to run a browser. The tradeoff is that a doubutsu palette edit can
// land, pass every other check, and still ship an installer window
// wearing the previous release's colors. Nothing about a png says how
// old it is, so the renderer stamps a hash of its inputs next to it and
// this compares the two. Same shape as licenses:check.
//
// Run by lefthook pre-commit, and by hand as `pnpm test dmg-art`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DMG_ART_DIR } from "../shared/packaging/dmgLayout.mts";
import {
  ART_FILES,
  ART_STAMP_FILE,
  artInputsHash,
} from "../scripts/lib/dmgArtStamp.mjs";
import { report, repoRoot } from "./lib/checkKit.mjs";

const failures = [];
const missing = ART_FILES.filter((file) => !existsSync(join(repoRoot, file)));
if (missing.length > 0) {
  // Hashing reads every art file, so a missing twin short-circuits
  // before the stamp comparison.
  failures.push(
    `the installer artwork is incomplete, missing ${missing.join(", ")}.`,
  );
} else {
  const stamped = existsSync(ART_STAMP_FILE)
    ? readFileSync(ART_STAMP_FILE, "utf8").trim()
    : null;
  if (stamped !== artInputsHash()) {
    failures.push(
      stamped === null
        ? `no stamp at ${DMG_ART_DIR}/inputs.sha256.`
        : "the installer artwork predates a change to the design it is rendered from.",
    );
  }
}
report({
  name: "dmg art",
  failures,
  hint: "Re-render it with `pnpm dmg:background` and commit the result.",
});
