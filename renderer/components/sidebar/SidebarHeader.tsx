import { useState } from "react";
import { isMac } from "@/lib/platform";
import { cn, dragRegion } from "@/lib/utils";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";

export function SidebarHeader() {
  const { data: runtime } = useRuntimeInfo();
  const isDev = runtime?.isDev ?? false;
  // One-way peek at prod styling. Reset on unmount (window reload).
  // Once flipped, the markup below is identical to the packaged build.
  const [revealProd, setRevealProd] = useState(false);
  const showDevStyle = isDev && !revealProd;
  return (
    <div
      // Title-bar drag region. The left inset clears the macOS traffic
      // lights; Windows keeps its caption buttons top-right, over the
      // main pane, so the sidebar needs no reserve.
      className={cn("flex h-[52px] items-center px-3", isMac && "pl-[92px]")}
      style={dragRegion("drag")}
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- internal dev affordance, no keyboard equivalent needed */}
      <div
        className={cn(
          "min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight",
          showDevStyle && "font-mono text-amber-500",
        )}
        onClick={showDevStyle ? () => setRevealProd(true) : undefined}
        // Carve a no-drag hole only while the affordance is active so the
        // click isn't eaten by the title-bar drag region.
        style={showDevStyle ? dragRegion("no-drag") : undefined}
      >
        Shigoto no Mori
      </div>
    </div>
  );
}
