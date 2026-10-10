// Durable proof for the launcher icons (packages/ui/src/app-icons), which the
// launcher row finds by file name (components/shared/LauncherIcon.tsx).
//
// Asserts:
// - every icon is named for an app in the engine's launcher catalog
//   (packages/engine/src/data/launcher-catalog.json), so none is
//   misnamed or left behind by a removed launcher
//
// Run: pnpm test launcher-icons.
//
// covers: packages/ui/src/app-icons/** packages/engine/src/data/launcher-catalog.json
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { repoRoot } from "./lib/checkKit.mts";

const catalog: { id: string }[] = JSON.parse(
  readFileSync(
    join(
      repoRoot,
      "packages",
      "engine",
      "src",
      "data",
      "launcher-catalog.json",
    ),
    "utf8",
  ),
);
const ids = new Set(catalog.map((app) => app.id));
const icons = readdirSync(join(repoRoot, "packages", "ui", "src", "app-icons"));

it("every icon names a catalog app", () => {
  assert.ok(icons.length > 0, "app-icons has icons");
  for (const icon of icons) {
    assert.match(icon, /\.png$/, `${icon} is a PNG`);
    const id = icon.slice(0, -".png".length);
    assert.ok(ids.has(id), `${icon} names no app in the launcher catalog`);
  }
});
