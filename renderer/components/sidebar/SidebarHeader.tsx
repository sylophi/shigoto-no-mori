import { useState } from "react";
import { cn, dragRegion } from "@/lib/utils";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";

// Dev builds mark the title so a stray window is never mistaken for the
// packaged app. Both themes also carry a one-way peek at prod styling:
// once revealed, the markup is identical to the packaged build.
type DevAffordance = {
  showDevStyle: boolean;
  onRevealProd: () => void;
};

// Both headers always render; `doubutsu-only` / `v1-only` pick which
// shows. A JS branch on the theme would fork this component per theme
// and be invisible to `pnpm theme:check`.
export function SidebarHeader() {
  const { data: runtime } = useRuntimeInfo();
  const isDev = runtime?.isDev ?? false;
  // Reset on unmount (window reload).
  const [revealProd, setRevealProd] = useState(false);
  const dev: DevAffordance = {
    showDevStyle: isDev && !revealProd,
    onRevealProd: () => setRevealProd(true),
  };
  return (
    <>
      <DoubutsuBrandHeader {...dev} />
      <DefaultSidebarHeader {...dev} />
    </>
  );
}

// The "album-art" moment of doubutsu mode: a cream pill anchoring the
// sidebar, with 仕事の森 as the hero and a giant 森 watermark bleeding
// off the corner. Cream-on-mint gives the pill a calm-card-on-shelf
// feel against the leaf-patterned sidebar.
function DoubutsuBrandHeader({ showDevStyle, onRevealProd }: DevAffordance) {
  return (
    <>
      {/* Draggable spacer reserves the macOS traffic-light area so the
          pill below doesn't get overlapped by the window controls. */}
      <div className="doubutsu-only h-10 shrink-0" style={dragRegion("drag")} />
      <div className="doubutsu-only relative mx-3 mb-2 overflow-hidden rounded-2xl bg-card px-5 pt-4 pb-5">
        {/* Dev swaps the hero's near-black ink for leaf green -- loud
            enough to catch at a glance, still inside the palette. */}
        <h1
          className={cn(
            "relative z-[1] text-[28px] leading-none font-black tracking-tight",
            showDevStyle ? "text-primary" : "text-foreground",
          )}
        >
          仕事の森
        </h1>
        <span className="relative z-[1] mt-1.5 block text-[12px] font-bold text-muted-foreground">
          Shigoto no Mori
        </span>
        {showDevStyle && (
          // Sticker slapped on the corner of the card, AC-style. Doubles
          // as the reveal-prod affordance (the pill isn't a drag region,
          // so the click lands without carving a no-drag hole).
          <button
            type="button"
            onClick={onRevealProd}
            title="Dev build — click to preview production styling"
            className="absolute top-3 right-3 z-[2] -rotate-6 rounded-full bg-primary px-2 py-[3px] text-[10px] leading-none font-black tracking-widest text-primary-foreground uppercase"
          >
            dev
          </button>
        )}
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

function DefaultSidebarHeader({ showDevStyle, onRevealProd }: DevAffordance) {
  return (
    <div
      // Title-bar drag region. The left inset clears the traffic lights.
      className="v1-only flex h-[52px] items-center gap-2 px-3 pl-[92px]"
      style={dragRegion("drag")}
    >
      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">
        Shigoto no Mori
      </div>
      {showDevStyle && (
        // Dev keeps the title itself intact and hangs a quiet mono chip
        // off it -- reads instantly, still lets the wordmark sit right.
        // Doubles as the reveal-prod affordance, so it carves a no-drag
        // hole out of the title bar for its own click.
        <button
          type="button"
          onClick={onRevealProd}
          title="Dev build — click to preview production styling"
          style={dragRegion("no-drag")}
          className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] leading-none font-medium tracking-widest text-muted-foreground uppercase transition-colors hover:border-foreground/25 hover:text-foreground"
        >
          dev
        </button>
      )}
    </div>
  );
}
