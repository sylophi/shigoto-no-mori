// The platform label a device enrolls under, and the one trait read off
// it. Its own module so the device kind catalog can read the browser
// label without pulling the enrollment orchestration, and its service
// and protocol imports, into a cycle.

// The platform label a browser enrolls under, beside the desktop's
// os.platform() values. Producers (the web bridge, the lab) and the
// consumers that branch on it (the registry row's traits, the kind
// fallback) share this so a typo cannot silently turn a browser into
// a desktop row.
export const WEB_PLATFORM = "web";

// Whether a device of this platform registers projects. The one trait
// a list filters on, here so the host's device roster (the CLI's
// cross-device verbs) and the renderer's lists cannot disagree.
export function hostsProjects(platform: string): boolean {
  return platform !== WEB_PLATFORM;
}
