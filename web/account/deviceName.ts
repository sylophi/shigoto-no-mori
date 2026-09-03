// The default name a web device enrolls under: a short, human-readable
// "browser on OS" derived from the user agent and, where the browser
// offers them, its client hints. The web analogue of the desktop's
// computer-name default. Pure string work so the headless bridge check
// can assert the mapping without a browser. Deliberately coarse: user
// agents lie and freeze, so this only needs to tell "Chrome on macOS"
// apart from "Firefox on Windows" in the device list, and the user can
// rename the device afterwards.
//
// The hints exist because every Chromium fork's user agent string says
// "Chrome": Edge, Brave, Opera and the rest all enroll as Chrome from
// the string alone. navigator.userAgentData.brands is the one place a
// fork states its own name (not all do: Arc and Vivaldi keep quiet and
// stay "Chrome"), and Brave, which used to ship no brand entry, is
// caught by the navigator.brave object only it defines.

export type BrowserHints = {
  // navigator.userAgentData.brands, brand strings only. Chromium only,
  // undefined elsewhere.
  brands?: readonly string[];
  // Whether navigator.brave exists.
  brave?: boolean;
};

// The hints as a real browser exposes them. Reads the navigator shape
// loosely because userAgentData is not in the DOM lib yet.
export function browserHintsOf(nav: Navigator): BrowserHints {
  const withHints = nav as Navigator & {
    userAgentData?: { brands?: { brand: string }[] };
    brave?: unknown;
  };
  return {
    brands: withHints.userAgentData?.brands?.map((entry) => entry.brand),
    brave: withHints.brave !== undefined,
  };
}

// Brand entries as their products are called. An entry outside this
// table passes through as the browser spelled it.
const BRAND_LABELS: Record<string, string> = {
  "Google Chrome": "Chrome",
  "Microsoft Edge": "Edge",
};

// Every Chromium build pads its brand list with a GREASE entry ("Not
// A;Brand", "Not/A)Brand", ...) and names Chromium itself; neither is
// the product. A list with nothing else says no more than the user
// agent does, so the caller falls through to it.
const GREASE = /not.?a.?brand/i;

function brandLabel(brands: readonly string[] | undefined): string | null {
  for (const brand of brands ?? []) {
    if (brand === "Chromium" || GREASE.test(brand)) continue;
    return BRAND_LABELS[brand] ?? brand;
  }
  return null;
}

// Ordered by specificity: Edge and Opera embed "Chrome" in their user
// agents, and everything WebKit embeds "Safari", so the generic tokens
// must come last.
const BROWSERS: readonly [pattern: RegExp, label: string][] = [
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

// iPad and iPhone before Mac (an iPad UA can carry "like Mac OS X"),
// and Android before Linux (Android UAs carry "Linux"). The Apple
// handhelds are named as the device rather than the OS because that is
// what tells the two apart in a list, and what their owners call them.
const PLATFORMS: readonly [pattern: RegExp, label: string][] = [
  [/iPad/, "iPad"],
  [/iPhone/, "iPhone"],
  [/Android/, "Android"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

function firstMatch(
  table: readonly [RegExp, string][],
  userAgent: string,
): string | null {
  for (const [pattern, label] of table) {
    if (pattern.test(userAgent)) return label;
  }
  return null;
}

// Always non-empty and far under EnrollRequestSchema's 256-char name
// bound, so a stored default can never later fail enroll's schema.
export function defaultWebDeviceName(
  userAgent: string,
  hints: BrowserHints = {},
): string {
  const browser =
    (hints.brave === true ? "Brave" : null) ??
    brandLabel(hints.brands) ??
    firstMatch(BROWSERS, userAgent) ??
    "Browser";
  const platform = firstMatch(PLATFORMS, userAgent);
  return platform === null ? browser : `${browser} on ${platform}`;
}
