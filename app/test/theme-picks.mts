// How a stored client config decodes into the doubutsu switch and the
// two palette picks (shared/themes.ts): the switch defaults on, each
// pick to its list's default, and a pick keeps while the switch is
// off so it comes back with it.
//
// covers: app/index.html app/web/public/boot-theme.js
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
  nextVariant,
  resolveDoubutsuPicks,
  rotationTurn,
  type DoubutsuPicks,
  type ThemeOption,
} from "@shared/themes";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("theme picks proof");

// A catalog's ids, each swatch's variants after it, as the schema
// lists them.
function ids(options: readonly ThemeOption<string>[]): string[] {
  return options.flatMap((o) => [o.id, ...(o.variants ?? [])]);
}

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
    assert.deepEqual(ids(LIGHT_THEMES), [...LIGHT_THEME_IDS]);
    assert.deepEqual(ids(DARK_THEMES), [...DARK_THEME_IDS]);
    assert.equal(
      LIGHT_THEMES.length,
      DARK_THEMES.length,
      "the two catalogs pair by position, so they are the same length",
    );
  });

  await proof.check(
    "a rotation moves both picks a swatch along, round the list",
    () => {
      assert.deepEqual(rotationTurn({ themeRotation: "launch" }, 7, true), {
        lightTheme: "latte",
        darkTheme: "forest",
        themeRotatedAt: 7,
      });
      assert.deepEqual(
        rotationTurn(
          { themeRotation: "launch", lightTheme: "sakura", darkTheme: "wood" },
          7,
          true,
        ),
        { lightTheme: "snow", darkTheme: "cocoa", themeRotatedAt: 7 },
      );
      // A variant is its swatch's place, and the defaults store by
      // omission.
      assert.deepEqual(
        rotationTurn(
          {
            themeRotation: "launch",
            lightTheme: "meadow",
            darkTheme: "yozakura",
          },
          7,
          true,
        ),
        { lightTheme: undefined, darkTheme: undefined, themeRotatedAt: 7 },
      );
      assert.equal(
        rotationTurn(
          { themeRotation: "launch", lightTheme: "latte-sage" },
          7,
          true,
        )?.lightTheme,
        "sky",
      );
    },
  );

  await proof.check("a rotation turns only when it is due", () => {
    const hour = 60 * 60 * 1000;
    assert.equal(rotationTurn({}, hour, true), null);
    assert.equal(rotationTurn({ themeRotation: "launch" }, hour, false), null);
    assert.equal(
      rotationTurn({ themeRotation: "launch", doubutsu: false }, hour, true),
      null,
    );
    const hourly = { themeRotation: "hourly", themeRotatedAt: hour } as const;
    assert.equal(rotationTurn(hourly, 2 * hour - 1, true), null);
    assert.notEqual(rotationTurn(hourly, 2 * hour, false), null);
  });

  await proof.check("the hidden hotkey cycles a swatch's variants", () => {
    assert.equal(nextVariant(LIGHT_THEMES, "latte"), "latte-sage");
    assert.equal(nextVariant(LIGHT_THEMES, "latte-sage"), "latte-mocha");
    assert.equal(nextVariant(LIGHT_THEMES, "latte-mocha"), "latte");
    assert.equal(nextVariant(LIGHT_THEMES, "sky"), null);
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
