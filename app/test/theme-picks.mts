// How a stored client config decodes into the doubutsu switch and the
// two palette picks (ui's lib/themes.ts): the switch defaults on, each
// pick to its list's default, and a pick keeps while the switch is
// off so it comes back with it. And the palette rotation: which pair
// a turn moves to, when one is due (a clock set back included), and
// that its owner makes a launch's turn once however many windows ask.
//
// covers: app/web/public/boot-theme.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEME_STORAGE_KEY } from "@/hooks/ui/useTheme";
import { PHONE_BELOW_PX } from "@/hooks/ui/useViewport";
import { join } from "node:path";
import {
  DARK_THEME_IDS,
  LIGHT_THEME_IDS,
} from "@shigomori/contracts/schemas/config";
import {
  activeTheme,
  DARK_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  LIGHT_THEMES,
  nextVariant,
  resolveDoubutsuPicks,
  rotationOwner,
  rotationTurn,
  darkTwin,
  lightTwin,
  type DoubutsuPicks,
  type ThemeOption,
} from "@shigomori/ui/lib/themes.ts";
import { it } from "vitest";

// A catalog's ids, each swatch's variants after it, as the schema
// lists them.
function ids(options: readonly ThemeOption<string>[]): string[] {
  return options.flatMap((o) => [o.id, ...(o.variants ?? [])]);
}

it("an empty config is the switch on and the two defaults", () => {
  assert.deepEqual(resolveDoubutsuPicks({}), {
    doubutsu: true,
    light: DEFAULT_LIGHT_THEME,
    dark: DEFAULT_DARK_THEME,
  });
});

it("explicit picks win, each on its own", () => {
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

it("the opt-out keeps the picks for when it lifts", () => {
  assert.deepEqual(
    resolveDoubutsuPicks({ doubutsu: false, darkTheme: "forest" }),
    { doubutsu: false, light: DEFAULT_LIGHT_THEME, dark: "forest" },
  );
});

it("the active palette follows the resolved appearance", () => {
  const picks: DoubutsuPicks = {
    doubutsu: true,
    light: "snow",
    dark: "cocoa",
  };
  assert.equal(activeTheme(picks, "light"), "snow");
  assert.equal(activeTheme(picks, "dark"), "cocoa");
});

it("no palette is active with the switch off", () => {
  const picks: DoubutsuPicks = {
    doubutsu: false,
    light: "snow",
    dark: "cocoa",
  };
  assert.equal(activeTheme(picks, "light"), null);
  assert.equal(activeTheme(picks, "dark"), null);
});

it("the catalog names every id once, in schema order", () => {
  assert.deepEqual(ids(LIGHT_THEMES), [...LIGHT_THEME_IDS]);
  assert.deepEqual(ids(DARK_THEMES), [...DARK_THEME_IDS]);
  assert.equal(
    LIGHT_THEMES.length,
    DARK_THEMES.length,
    "the two catalogs pair by position, so they are the same length",
  );
});

it("a rotation moves to the pair after the light pick's, round the list", () => {
  assert.deepEqual(rotationTurn({ themeRotation: "launch" }, 7, true), {
    lightTheme: "latte",
    darkTheme: "cocoa",
    themeRotatedAt: 7,
  });
  // An unmatched dark pick falls in with the light one.
  assert.deepEqual(
    rotationTurn(
      { themeRotation: "launch", lightTheme: "sky", darkTheme: "wood" },
      7,
      true,
    ),
    { lightTheme: "sakura", darkTheme: "yozakura", themeRotatedAt: 7 },
  );
  assert.deepEqual(
    rotationTurn({ themeRotation: "launch", lightTheme: "sakura" }, 7, true),
    { lightTheme: "snow", darkTheme: undefined, themeRotatedAt: 7 },
  );
  // A variant is its swatch's place.
  assert.equal(
    rotationTurn({ themeRotation: "launch", lightTheme: "latte-sage" }, 7, true)
      ?.lightTheme,
    "sky",
  );
});

it("a pick's twin is the other half of its pair", () => {
  assert.equal(darkTwin("snow"), "charcoal");
  assert.equal(darkTwin("latte-mocha"), "cocoa");
  assert.equal(lightTwin("yozakura"), "sakura");
});

it("a rotation turns only when it is due", () => {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  assert.equal(rotationTurn({}, hour, true), null);
  assert.equal(rotationTurn({ themeRotation: "launch" }, hour, false), null);
  assert.equal(
    rotationTurn({ themeRotation: "launch", doubutsu: false }, hour, true),
    null,
  );
  for (const [every, span] of [
    ["hourly", hour],
    ["daily", day],
    ["weekly", 7 * day],
  ] as const) {
    const config = { themeRotation: every, themeRotatedAt: day } as const;
    assert.equal(rotationTurn(config, day + span - 1, true), null, every);
    assert.notEqual(rotationTurn(config, day + span, false), null, every);
  }
});

it("the hidden hotkey cycles a swatch's variants", () => {
  assert.equal(nextVariant(LIGHT_THEMES, "latte"), "latte-sage");
  assert.equal(nextVariant(LIGHT_THEMES, "latte-sage"), "latte-mocha");
  assert.equal(nextVariant(LIGHT_THEMES, "latte-mocha"), "latte");
  assert.equal(nextVariant(LIGHT_THEMES, "sky"), null);
});

it("the boot script paints the catalog's defaults and reads its mirrors", () => {
  // The pre-paint script can't import the catalog (it must stay a
  // classic script for the windows' and the web deploy's CSP), so it
  // repeats the two default ids, the four storage keys and the phone
  // width. This holds the copies to the source.
  const src = readFileSync(
    join(import.meta.dirname, "..", "web/public/boot-theme.js"),
    "utf8",
  );
  for (const needle of [
    `"${DEFAULT_LIGHT_THEME}"`,
    `"${DEFAULT_DARK_THEME}"`,
    '"shigomori.doubutsu"',
    '"shigomori.lightTheme"',
    '"shigomori.darkTheme"',
    `"${THEME_STORAGE_KEY}"`,
    `< ${PHONE_BELOW_PX}`,
  ]) {
    assert.ok(src.includes(needle), `boot-theme.js lost ${needle}`);
  }
});

it("a clock set back since the last turn turns again", () => {
  const day = 24 * 60 * 60 * 1000;
  const config = { themeRotation: "weekly", themeRotatedAt: 10 * day } as const;
  assert.notEqual(rotationTurn(config, 9 * day, false), null);
});

it("the owner makes a launch's turn once, the timed ones whenever due", () => {
  const hour = 60 * 60 * 1000;
  const turnOf = rotationOwner();
  const launch = { themeRotation: "launch" } as const;
  assert.notEqual(turnOf(launch, hour, true), null, "the first window");
  assert.equal(turnOf(launch, hour, true), null, "a second window, a reload");
  const hourly = { themeRotation: "hourly", themeRotatedAt: 0 } as const;
  assert.notEqual(turnOf(hourly, hour, false), null);
  assert.notEqual(turnOf(hourly, hour, true), null, "due, launch or not");
});
