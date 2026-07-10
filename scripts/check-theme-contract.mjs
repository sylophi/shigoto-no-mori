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
//   4. The rasterized doubutsu hexes in main/electron/chrome/win32.ts
//      must match the CSS tokens -- catches palette retunes that forget
//      the native Windows chrome.
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

// 4. Native chrome sync: the win32 window chrome carries sRGB hexes of
//    the doubutsu background/card/foreground tokens. Convert the CSS
//    tokens (OKLCH) ourselves and require the exact hex to appear in
//    win32.ts, so retuning the palette can't silently strand the
//    Windows shell on stale colors.
const srgbGamma = (x) =>
  x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;

function oklchToHex(lightness, chroma, hueDeg) {
  const hue = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const L = lRoot ** 3;
  const M = mRoot ** 3;
  const S = sRoot ** 3;
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  return (
    "#" +
    lin
      .map((x) =>
        Math.round(Math.min(1, Math.max(0, srgbGamma(x))) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

const win32Path = join(root, "main/electron/chrome/win32.ts");
const win32Source = readFileSync(win32Path, "utf8");
for (const [label, blockRe] of [
  ["light", /:root\.doubutsu\s*\{([^}]*)\}/],
  ["dark", /:root\.doubutsu\.dark\s*\{([^}]*)\}/],
]) {
  const block = css.match(blockRe)?.[1] ?? "";
  for (const token of ["background", "card", "foreground"]) {
    const m = block.match(
      new RegExp(
        `--${token}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`,
      ),
    );
    if (!m) {
      failures.push(
        `doubutsu.css: couldn't parse --${token} in the ${label} block (chrome-sync check needs plain oklch(L C H) values)`,
      );
      continue;
    }
    const hex = oklchToHex(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!win32Source.includes(hex)) {
      failures.push(
        `win32 chrome out of sync: ${label} --${token} is now ${hex}, but main/electron/chrome/win32.ts doesn't contain it -- update its chromeColors hexes`,
      );
    }
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
