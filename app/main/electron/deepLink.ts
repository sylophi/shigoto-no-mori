// Inbound deep links: `<scheme>://open/<route>` opens a device's page,
// e.g. shigomori://open/devices/<id>/projects/<id>/worktrees/<id>, or
// this device's with the /devices/<id> prefix left off.
// The OS hands a link to main (open-url on macOS, the argv of a launch
// elsewhere), possibly before the window exists or while its renderer
// is still booting. So main only holds the latest link and nudges the
// window, and the renderer takes the link once it can navigate
// (renderer/hooks/ui/useDeepLinks.ts).
import type { WebContents } from "electron";
import { navContract } from "@shared/ipc/modules/nav";
import { DEEP_LINK_HOST } from "@shared/packaging/rendererScheme.mts";
import { broadcast } from "../ipc/register";
import { rendererScheme } from "./clerk";

let pending: string | null = null;

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

export function deepLinkRouteInArgv(argv: string[]): string | null {
  for (const arg of argv) {
    const route = deepLinkRoute(arg);
    if (route !== null) return route;
  }
  return null;
}

// A later link replaces an untaken one: the user wants the page they
// asked for last.
export function receiveDeepLink(
  route: string,
  webContents: WebContents | undefined,
): void {
  pending = route;
  if (webContents) broadcast(navContract, "deepLink", undefined, webContents);
}

export function takeDeepLink(): string | null {
  const route = pending;
  pending = null;
  return route;
}
