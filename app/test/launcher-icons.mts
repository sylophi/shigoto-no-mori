// Durable proof for the launcher icons (renderer/app-icons), which the
// launcher row finds by file name (components/shared/LauncherIcon.tsx).
//
// Asserts:
// - every icon is named for an app in the CLI's launcher catalog
//   (cli/embed/launcher-catalog.json), so none is misnamed or left
//   behind by a removed launcher
//
// Run: pnpm test launcher-icons.
//
// covers: app/renderer/app-icons/** cli/embed/launcher-catalog.json
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot, makeProof, repoRoot } from "./lib/checkKit.mts";

const proof = makeProof("launcher-icons proof");
console.log("launcher-icons proof\n");

// The catalog is the CLI's embed, one level up from the app.
const catalog: { id: string }[] = JSON.parse(
  readFileSync(join(repoRoot, "cli", "embed", "launcher-catalog.json"), "utf8"),
);
const ids = new Set(catalog.map((app) => app.id));
const icons = readdirSync(join(appRoot, "renderer", "app-icons"));

try {
  await proof.check("every icon names a catalog app", () => {
    assert.ok(icons.length > 0, "app-icons has icons");
    for (const icon of icons) {
      assert.match(icon, /\.png$/, `${icon} is a PNG`);
      const id = icon.slice(0, -".png".length);
      assert.ok(ids.has(id), `${icon} names no app in the launcher catalog`);
    }
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
