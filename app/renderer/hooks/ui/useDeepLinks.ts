// Opens the page a deep link names (`<scheme>://open/<route>`, see
// main/electron/deepLink.ts): the route is a device page's own path
// minus its /devices/$deviceId prefix, so the router resolves it like
// any other path, and a path it has no page for shows its not-found
// page. Main holds the link and nudges, so this takes on mount too: a
// link that launched the app arrived before anything listened. Desktop
// only, a browser tab receives no links.
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";

export function useDeepLinks(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!hasLocalHost) return;
    const take = () => {
      window.api.nav
        .takeDeepLink()
        .then((route) => {
          if (route !== null) {
            void navigate({ href: `/devices/${localDeviceId}${route}` });
          }
        })
        .catch((error: unknown) => {
          console.warn("[deep link] couldn't take the pending link:", error);
        });
    };
    take();
    return window.api.nav.onDeepLink(take);
  }, [navigate]);
}
