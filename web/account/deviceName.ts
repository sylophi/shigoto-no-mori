// The default name a web device enrolls under: a short, human-readable
// "browser on OS" derived from the user agent, the web analogue of the
// desktop's hostname() default. Pure string work so the headless bridge
// check can assert the mapping without a browser. Deliberately coarse:
// user agents lie and freeze, so this only needs to tell "Chrome on
// macOS" apart from "Firefox on Windows" in the device list, and the
// user can rename the device afterwards.

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

// iPhone/iPad before Mac (an iPad UA can carry "like Mac OS X"), and
// Android before Linux (Android UAs carry "Linux").
const PLATFORMS: readonly [pattern: RegExp, label: string][] = [
  [/iPhone|iPad/, "iOS"],
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
export function defaultWebDeviceName(userAgent: string): string {
  const browser = firstMatch(BROWSERS, userAgent) ?? "Browser";
  const platform = firstMatch(PLATFORMS, userAgent);
  return platform === null ? browser : `${browser} on ${platform}`;
}
