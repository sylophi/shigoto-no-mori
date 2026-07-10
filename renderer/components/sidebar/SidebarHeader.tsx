import { useState } from "react";
import { isMac } from "@/lib/platform";
import { cn, dragRegion } from "@/lib/utils";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";

export function SidebarHeader() {
  const { applied: doubutsu } = useDoubutsu();
  if (doubutsu) return <DoubutsuBrandHeader />;
  return <DefaultSidebarHeader />;
}

// The "album-art" moment of doubutsu mode: a cream pill anchoring the
// sidebar, with 仕事の森 as the hero and a giant 森 watermark bleeding
// off the corner. Cream-on-mint gives the pill a calm-card-on-shelf
// feel against the leaf-patterned sidebar.
function DoubutsuBrandHeader() {
  return (
    <>
      {/* Draggable spacer reserves the macOS traffic-light area so the
          pill below doesn't get overlapped by the window controls. */}
      <div className="h-10 shrink-0" style={dragRegion("drag")} />
      <div className="relative mx-3 mb-2 overflow-hidden rounded-2xl bg-card px-5 pt-4 pb-5">
        <h1 className="relative z-[1] text-[28px] leading-none font-black tracking-tight text-foreground">
          仕事の森
        </h1>
        <span className="relative z-[1] mt-1.5 block text-[12px] font-bold text-muted-foreground">
          Shigoto no Mori
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute -right-4 -bottom-10 text-[140px] leading-none font-black text-[var(--doubutsu-watermark)] opacity-15 select-none"
        >
          森
        </span>
      </div>
    </>
  );
}

function DefaultSidebarHeader() {
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
