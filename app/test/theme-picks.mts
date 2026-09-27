// How a stored client config decodes into the doubutsu switch and the
// two palette picks (shared/themes.ts): the switch defaults on, each
// pick to its list's default, and a pick keeps while the switch is
// off so it comes back with it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DARK_THEME_IDS, LIGHT_THEME_IDS } from "@shared/schemas/config";
import {
  activeTheme,
  DARK_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  LIGHT_THEMES,
  resolveDoubutsuPicks,
  type DoubutsuPicks,
} from "@shared/themes";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("theme picks proof");

try {
  await proof.check(
    "an empty config is the switch on and the two defaults",
    () => {
      assert.deepEqual(resolveDoubutsuPicks({}), {
        doubutsu: true,
        light: DEFAULT_LIGHT_THEME,
        dark: DEFAULT_DARK_THEME,
      });
    },
  );

  await proof.check("explicit picks win, each on its own", () => {
    assert.deepEqual(resolveDoubutsuPicks({ lightTheme: "sakura" }), {
      doubutsu: true,
      light: "sakura",
      dark: DEFAULT_DARK_THEME,
    });
    assert.deepEqual(
      resolveDoubutsuPicks({ lightTheme: "sky", darkTheme: "midnight" }),
      { doubutsu: true, light: "sky", dark: "midnight" },
    );
  });

  await proof.check("the opt-out keeps the picks for when it lifts", () => {
    assert.deepEqual(
      resolveDoubutsuPicks({ doubutsu: false, darkTheme: "forest" }),
      { doubutsu: false, light: DEFAULT_LIGHT_THEME, dark: "forest" },
    );
  });

  await proof.check(
    "the active palette follows the resolved appearance",
    () => {
      const picks: DoubutsuPicks = {
        doubutsu: true,
        light: "snow",
        dark: "cocoa",
      };
      assert.equal(activeTheme(picks, "light"), "snow");
      assert.equal(activeTheme(picks, "dark"), "cocoa");
    },
  );

  await proof.check("no palette is active with the switch off", () => {
    const picks: DoubutsuPicks = {
      doubutsu: false,
      light: "snow",
      dark: "cocoa",
    };
    assert.equal(activeTheme(picks, "light"), null);
    assert.equal(activeTheme(picks, "dark"), null);
  });

  await proof.check("the catalog names every id once, in schema order", () => {
    assert.deepEqual(
      LIGHT_THEMES.map((t) => t.id),
      [...LIGHT_THEME_IDS],
    );
    assert.deepEqual(
      DARK_THEMES.map((t) => t.id),
      [...DARK_THEME_IDS],
    );
    assert.equal(
      LIGHT_THEME_IDS.length,
      DARK_THEME_IDS.length,
      "the two lists pair by index, so they are the same length",
    );
  });
  await proof.check(
    "both boot scripts paint the catalog's defaults and read its mirrors",
    () => {
      // The pre-paint scripts can't import the catalog (one is inline
      // in index.html, the other must stay a classic script for the
      // web deploy's CSP), so they repeat the two default ids and the
      // three storage keys. This holds the copies to the source.
      for (const file of ["index.html", "web/public/boot-theme.js"]) {
        const src = readFileSync(join(import.meta.dirname, "..", file), "utf8");
        for (const needle of [
          `"${DEFAULT_LIGHT_THEME}"`,
          `"${DEFAULT_DARK_THEME}"`,
          '"shigomori.doubutsu"',
          '"shigomori.lightTheme"',
          '"shigomori.darkTheme"',
        ]) {
          assert.ok(src.includes(needle), `${file} lost ${needle}`);
        }
      }
    },
  );
  proof.done();
} catch (error) {
  proof.fail(error);
}
