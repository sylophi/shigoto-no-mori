// Durable proof for the material icons the file pickers show
// (vite.materialIcons.ts): every build of the renderer tree carries
// them, and a build puts them beside its page, where the views ask
// for them (packages/ui's lib/materialIcons.ts, `iconUrl`).
//
// Asserts:
// - the desktop window's, the web client's and both fake hosts'
//   configs take the plugin, which none of their public dirs replaces
// - a build's close copies every icon into its output folder
//
// Run: pnpm test material-icons.
//
// covers: app/vite.renderer.config.ts app/vite.web.config.ts app/lab/fake-host/vite.config.ts app/lab/fake-host/vite.web.config.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, it } from "vitest";
import {
  loadConfigFromFile,
  type ConfigEnv,
  type Plugin,
  type PluginOption,
} from "vite";
import { materialIcons } from "../vite.materialIcons";

const app = join(import.meta.dirname, "..");

// A config's plugins nest in arrays (a plugin may return several).
const pluginNames = (plugins: readonly PluginOption[] = []): string[] =>
  plugins.flatMap((plugin): string[] => {
    if (Array.isArray(plugin)) return pluginNames(plugin);
    return plugin && typeof plugin === "object" && "name" in plugin
      ? [plugin.name]
      : [];
  });

it.each([
  "vite.renderer.config.ts",
  "vite.web.config.ts",
  "lab/fake-host/vite.config.ts",
  "lab/fake-host/vite.web.config.ts",
])("%s serves and builds the icons", async (file) => {
  const loaded = await loadConfigFromFile(
    // The forge plugin's own fields, which only the renderer's config
    // takes, and none of it reads.
    { command: "build", mode: "production" } as ConfigEnv,
    join(app, file),
    app,
    "silent",
  );
  assert.ok(loaded, `${file} loads`);
  assert.ok(
    pluginNames(loaded.config.plugins).includes("sm-material-icons"),
    `${file} takes the material icons plugin`,
  );
});

const outDir = mkdtempSync(join(tmpdir(), "sm-material-icons-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("copies every icon beside the built page", () => {
  const plugin = materialIcons() as Plugin & {
    configResolved: (config: unknown) => void;
    closeBundle: () => void;
  };
  plugin.configResolved({ root: app, build: { outDir } });
  plugin.closeBundle();
  const icons = readdirSync(join(outDir, "material-icons"));
  assert.ok(icons.length > 1000, `${icons.length} icons copied`);
  assert.ok(existsSync(join(outDir, "material-icons", "folder-src.svg")));
  assert.ok(existsSync(join(outDir, "material-icons", "readme.svg")));
});
