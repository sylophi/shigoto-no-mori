// Inbound deep links: `<scheme>://open/<route>` opens a device's page,
// e.g. shigomori://open/devices/<id>/projects/<id>/worktrees/<id>.
// macOS hands a link to main (open-url), possibly before any window
// exists or while its renderer is still booting. So the window set
// holds the link for the window it goes to and nudges it
// (main/electron/windows.ts), and the renderer takes the link once it
// can navigate (renderer/hooks/ui/useDeepLinks.ts).
import { DEEP_LINK_HOST } from "@shared/packaging/rendererScheme.mts";
import { rendererScheme } from "./clerk";

// The link's path, or null when the URL is not a deep link.
export function deepLinkRoute(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${rendererScheme()}:` ||
    parsed.host !== DEEP_LINK_HOST
  ) {
    return null;
  }
  return parsed.pathname;
}
