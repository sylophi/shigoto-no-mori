// Verifies that every hook renderer/doubutsu.css depends on still
// exists, so a v1 refactor (or a dependency upgrade) can't silently
// strip parts of doubutsu mode. Devs work in v1 by default -- without
// this check, a renamed data-slot or a Base UI attribute change would
// only be noticed by someone running with the theme on.
//
// Checked:
//   1. Every data-slot / data-doubutsu-zone / data-doubutsu-page /
//      data-variant value the CSS selects must be set somewhere in
//      renderer source.
//   2. The `doubutsu-only` and `data-row-idx` app markers must exist.
//   3. Upstream attributes (Base UI, cmdk, sonner) must still appear in
//      the installed packages -- catches breaking upgrades.
//   4. The one consumer outside renderer/ -- the dmg artwork in
//      scripts/dmg-background.html -- must still find the tokens and
//      the two rules it renders against. It ships as a committed png,
//      so a stripped hook there is invisible until a release.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { report, walk } from "./lib/checkKit.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Strip comments: only selectors are contract, prose may name anything.
const css = readFileSync(join(root, "renderer/doubutsu.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

let rendererSource = "";
for (const file of walk(join(root, "renderer"), /\.(tsx?|css)$/)) {
  if (file.endsWith("doubutsu.css")) continue;
  rendererSource += readFileSync(file, "utf8");
}

const failures = [];

// 1. data-* hooks the CSS selects must be set in renderer source.
//    (data-highlighted / data-popup-open / data-disabled / data-unchecked
//    are set by Base UI at runtime, data-sonner-toast by sonner --
//    checked below.)
const RUNTIME_ATTRS = new Set([
  "data-highlighted",
  "data-popup-open",
  "data-disabled",
  "data-unchecked",
  "data-sonner-toast",
]);
const attrRefs = [...css.matchAll(/\[(data-[\w-]+)(?:="([^"]+)")?\]/g)];
for (const [, attr, value] of attrRefs) {
  if (RUNTIME_ATTRS.has(attr)) continue;
  const literal = value ? `${attr}="${value}"` : `${attr}=`;
  // `data-variant={variant}`-style dynamic values can't be matched
  // literally; accept the attribute being set with any expression. A
  // valueless selector is also satisfied by a bare boolean attribute.
  const dynamic = `${attr}={`;
  const bare = !value && new RegExp(`${attr}\\s`).test(rendererSource);
  if (
    !rendererSource.includes(literal) &&
    !rendererSource.includes(dynamic) &&
    !bare
  ) {
    failures.push(
      `doubutsu.css selects [${attr}${value ? `="${value}"` : ""}] but no renderer component sets it`,
    );
  }
}

// 2. App-level markers.
for (const marker of ["doubutsu-only", "v1-only", "data-row-idx"]) {
  if (css.includes(marker) && !rendererSource.includes(marker)) {
    failures.push(
      `doubutsu.css references "${marker}" but renderer source no longer uses it`,
    );
  }
}

// 3. Upstream attribute contracts -- grep the installed packages so a
//    dependency upgrade that drops an attribute fails loudly here
//    instead of silently un-theming menus/toasts.
const upstream = [
  {
    pkg: "@base-ui/react",
    file: "node_modules/@base-ui/react/menu/item/MenuItemDataAttributes.js",
    needle: "data-highlighted",
  },
  {
    pkg: "@base-ui/react",
    file: "node_modules/@base-ui/react/utils/popupStateMapping.js",
    needle: "data-popup-open",
  },
  {
    pkg: "@base-ui/react",
    file: "node_modules/@base-ui/react/checkbox/root/CheckboxRootDataAttributes.js",
    needle: "data-unchecked",
  },
  {
    pkg: "cmdk",
    file: "node_modules/cmdk/dist/index.mjs",
    needle: "cmdk-item",
  },
  {
    pkg: "sonner",
    file: "node_modules/sonner/dist/index.mjs",
    needle: "data-sonner-toast",
  },
];
for (const { pkg, file, needle } of upstream) {
  const path = join(root, file);
  if (!existsSync(path)) {
    failures.push(
      `${pkg}: expected file ${file} is gone (upgrade moved it?) -- re-verify "${needle}" still exists and update this check`,
    );
  } else if (!readFileSync(path, "utf8").includes(needle)) {
    failures.push(
      `${pkg}: "${needle}" no longer found in ${file} -- doubutsu selectors depending on it are dead`,
    );
  }
}

// 4. The installer artwork renders against this stylesheet from outside
//    renderer/, so the walk above never sees it. Check the tokens it
//    reads are still declared, and that the two rule shapes it leans on
//    -- the leaf wallpaper and the header/footer band -- still exist.
const artFile = join(root, "scripts/dmg-background.html");
const art = readFileSync(artFile, "utf8");
// --dmg-*, --icon* and --app*-x are injected by the renderer at capture
// time. Everything else has to come from the theme.
const INJECTED = /^--(dmg-|icon|app-|apps-)/;
for (const [, name] of art.matchAll(/var\((--[\w-]+)\)/g)) {
  if (INJECTED.test(name)) continue;
  if (!css.includes(`${name}:`)) {
    failures.push(
      `dmg-background.html reads ${name} but doubutsu.css no longer declares it`,
    );
  }
}
const ART_RULES = [
  {
    needle: /\[data-doubutsu-zone="main"\]::before/,
    what: 'the leaf wallpaper on [data-doubutsu-zone="main"]',
  },
  {
    needle: /\[data-doubutsu-zone="main"\][^{]*:is\(\s*header,\s*footer\s*\)/,
    what: "the header/footer band rule",
  },
];
for (const { needle, what } of ART_RULES) {
  if (!needle.test(css)) {
    failures.push(
      `doubutsu.css no longer has ${what}, which the dmg artwork is drawn against`,
    );
  }
}

// 5. Clerk's prebuilt UI themes through renderer/lib/clerkAppearance.ts
//    (its appearance API, not doubutsu.css selectors), binding Clerk
//    variables to the app palette via CSS variables alone. Every BARE
//    var it reads (the regex skips vars carrying an explicit fallback,
//    which cannot silently break) must resolve in both systems: a v1
//    theme token declared as a real runtime property in index.css, or a
//    raw --color-* step that doubutsu.css remaps in BOTH its light and
//    dark blocks. A renamed token would otherwise break the sign-in
//    surfaces silently.
const clerkSrc = readFileSync(
  join(root, "renderer/lib/clerkAppearance.ts"),
  "utf8",
);
// @theme inline never emits its declarations as runtime custom
// properties (Tailwind inlines them into utilities), so strip those
// blocks: a token that exists only there is NOT resolvable via var().
const indexCss = readFileSync(join(root, "renderer/index.css"), "utf8").replace(
  /@theme[^{]*\{[^}]*\}/g,
  "",
);
// The doubutsu light block (:root.doubutsu) and dark block
// (:root.doubutsu.dark): a remap present in only one of them leaves
// the other mode on the raw hue.
const doubutsuDarkStart = css.indexOf(":root.doubutsu.dark");
const doubutsuLight = css.slice(0, doubutsuDarkStart);
const doubutsuDark = css.slice(doubutsuDarkStart);
for (const [, name] of clerkSrc.matchAll(/var\((--[\w-]+)\)/g)) {
  if (name.startsWith("--color-")) {
    for (const [block, label] of [
      [doubutsuLight, "light"],
      [doubutsuDark, "dark"],
    ]) {
      if (!block.includes(`${name}:`)) {
        failures.push(
          `clerkAppearance reads ${name} but doubutsu.css's ${label} block ` +
            "does not remap that step, so Clerk's UI would keep the raw " +
            "hue in that doubutsu mode",
        );
      }
    }
  } else if (!indexCss.includes(`${name}:`)) {
    failures.push(
      `clerkAppearance reads ${name} but renderer/index.css no longer ` +
        "declares it as a runtime property (an @theme inline entry does " +
        "not count: Tailwind never emits those as custom properties)",
    );
  }
}

report({
  name: "theme contract",
  failures,
  hint: "Either restore the hook, or update renderer/doubutsu.css (and its CONTRACT header) to the new one.",
});
