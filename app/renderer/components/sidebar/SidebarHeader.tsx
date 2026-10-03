import { useState } from "react";
import { hasLocalHost } from "@/lib/localHost";
import { SidebarHeaderView } from "./SidebarHeaderView";

// The sidebar's brand header (SidebarHeaderView), with the build and
// the shell read off the bridge.
export function SidebarHeader() {
  // A client fact off the preload bridge, not runtime.info: the badge
  // marks this build, never the host it talks to.
  const isDev = window.api.isDev;
  // Reset on unmount (window reload).
  const [revealProd, setRevealProd] = useState(false);
  return (
    <SidebarHeaderView
      hasLocalHost={hasLocalHost}
      showDevStyle={isDev && !revealProd}
      onRevealProd={() => setRevealProd(true)}
    />
  );
}
