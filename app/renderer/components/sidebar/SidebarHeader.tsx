// The sidebar's brand header (SidebarHeaderView). Dev builds mark the
// title so a stray window is never mistaken for the packaged app, with
// a one-way peek at prod styling, reset on unmount (window reload).
import { useState } from "react";
import { hasLocalHost } from "@/lib/localHost";
import { SidebarHeaderView } from "@shigomori/ui/views/sidebar/SidebarHeaderView.tsx";

export function SidebarHeader() {
  // A client fact off the preload bridge, not runtime.info: the badge
  // marks this build, never the host it talks to.
  const isDev = window.api.isDev;
  const [revealProd, setRevealProd] = useState(false);
  return (
    <SidebarHeaderView
      hasLocalHost={hasLocalHost}
      showDevStyle={isDev && !revealProd}
      onRevealProd={() => setRevealProd(true)}
    />
  );
}
