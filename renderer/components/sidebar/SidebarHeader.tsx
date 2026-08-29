import { useState } from "react";
import { cn, dragRegion } from "@/lib/utils";

// Dev builds mark the title so a stray window is never mistaken for the
// packaged app. Both themes also carry a one-way peek at prod styling:
// once revealed, the markup is identical to the packaged build.
type DevAffordance = {
  showDevStyle: boolean;
  onRevealProd: () => void;
};

interface SidebarHeaderProps {
  // False for the web shell: a browser tab has no title-bar drag region
  // and no traffic lights to clear.
  windowChrome?: boolean;
  // A static build marker ("web") in the corner slot the dev sticker
  // otherwise uses. Providing it replaces the dev affordance.
  badge?: string;
}

// Both headers always render; `doubutsu-only` / `v1-only` pick which
// shows. A JS branch on the theme would fork this component per theme
// and be invisible to `pnpm theme:check`.
export function SidebarHeader({
  windowChrome = true,
  badge,
}: SidebarHeaderProps) {
  // A client fact off the preload bridge, not runtime.info: the badge
  // marks this build, never the host it talks to.
  const isDev = window.api.isDev;
  // Reset on unmount (window reload).
  const [revealProd, setRevealProd] = useState(false);
  const dev: DevAffordance = {
    showDevStyle: badge === undefined && isDev && !revealProd,
    onRevealProd: () => setRevealProd(true),
  };
  return (
    <>
      <DoubutsuBrandHeader {...dev} windowChrome={windowChrome} badge={badge} />
      <DefaultSidebarHeader
        {...dev}
        windowChrome={windowChrome}
        badge={badge}
      />
    </>
  );
}

type ThemeHeaderProps = DevAffordance & {
  windowChrome: boolean;
  badge: string | undefined;
};

// The "album-art" moment of doubutsu mode: a cream pill anchoring the
// sidebar, with 仕事の森 as the hero and a giant 森 watermark bleeding
// off the corner. Cream-on-mint gives the pill a calm-card-on-shelf
// feel against the leaf-patterned sidebar.
function DoubutsuBrandHeader({
  showDevStyle,
  onRevealProd,
  windowChrome,
  badge,
}: ThemeHeaderProps) {
  return (
    <>
      {/* Draggable spacer reserves the macOS traffic-light area so the
          pill below doesn't get overlapped by the window controls. */}
      {windowChrome && (
        <div
          className="doubutsu-only h-10 shrink-0"
          style={dragRegion("drag")}
        />
      )}
      <div
        className={cn(
          "doubutsu-only relative mx-3 mb-2 overflow-hidden rounded-2xl bg-card px-5 pt-4 pb-5",
          !windowChrome && "mt-3",
        )}
      >
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
        {badge !== undefined ? (
          // Static build marker in the dev sticker's corner slot, calmer
          // (secondary, not the loud primary) because it never goes away.
          <span className="absolute top-3 right-3 z-[2] -rotate-6 rounded-full bg-secondary px-2 py-[3px] text-[10px] leading-none font-black tracking-widest text-secondary-foreground uppercase">
            {badge}
          </span>
        ) : (
          showDevStyle && (
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
          )
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

function DefaultSidebarHeader({
  showDevStyle,
  onRevealProd,
  windowChrome,
  badge,
}: ThemeHeaderProps) {
  return (
    <div
      // Title-bar drag region on the desktop, with the left inset
      // clearing the traffic lights. The web bar keeps the height,
      // drops both.
      className={cn(
        "v1-only flex h-[52px] items-center gap-2",
        windowChrome ? "px-3 pl-[92px]" : "px-4",
      )}
      style={windowChrome ? dragRegion("drag") : undefined}
    >
      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">
        Shigoto no Mori
      </div>
      {badge !== undefined ? (
        <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] leading-none font-medium tracking-widest text-muted-foreground uppercase">
          {badge}
        </span>
      ) : (
        showDevStyle && (
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
        )
      )}
    </div>
  );
}
