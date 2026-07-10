// Verifies that every hook renderer/doubutsu.css depends on still
// exists, so a v1 refactor (or a dependency upgrade) can't silently
// strip parts of doubutsu mode. Devs work in v1 by default -- without
// this check, a renamed data-slot or a Base UI attribute change would
// only be noticed by someone running with the theme on.
//
// Checked:
//   1. Every data-slot / data-doubutsu-zone / data-variant value the
//      CSS selects must be set somewhere in renderer source.
//   2. The `doubutsu-only` and `data-row-idx` app markers must exist.
//   3. Upstream attributes (Base UI, cmdk, sonner) must still appear in
//      the installed packages -- catches breaking upgrades.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Strip comments: only selectors are contract, prose may name anything.
const css = readFileSync(join(root, "renderer/doubutsu.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(tsx?|css)$/.test(entry.name)) yield path;
  }
}

let rendererSource = "";
for (const file of walk(join(root, "renderer"))) {
  if (file.endsWith("doubutsu.css")) continue;
  rendererSource += readFileSync(file, "utf8");
}

const failures = [];

// 1. data-* hooks the CSS selects must be set in renderer source.
//    (data-highlighted / data-popup-open / data-disabled are set by
//    Base UI at runtime, data-sonner-toast by sonner -- checked below.)
const RUNTIME_ATTRS = new Set([
  "data-highlighted",
  "data-popup-open",
  "data-disabled",
  "data-sonner-toast",
  // Stamped on <html> via document.documentElement.dataset in
  // renderer/index.tsx, so no JSX literal exists to grep.
  "data-platform",
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
for (const marker of ["doubutsu-only", "data-row-idx"]) {
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

if (failures.length > 0) {
  console.error("Theme contract check failed:\n");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(
    "\nEither restore the hook, or update renderer/doubutsu.css (and its CONTRACT header) to the new one.",
  );
  process.exit(1);
}
console.log("theme contract OK");
