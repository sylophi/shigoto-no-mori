// The full-page header shared by the top-level pages (Settings, Tidy,
// Devices, the project pages, and the web shell's pages): an eyebrow
// line, the page title, optional trailing marks, an optional device
// tab bar leading it, and the doubutsu watermark glyph. One component
// so the header chrome, the inset and the tab wiring live in exactly
// one place.
import type React from "react";
import { cn } from "@/lib/utils";

// One padding for both shells: the desktop pages sit under the window
// chrome, and since the web shell became a sidebar layout its pages
// have the same open canvas above them (the former slim-top-bar shell
// carried a pt-5 variant that no longer has a caller).
// The header's padding on its own, for the pages that draw a header of
// their own shape (the diff pages, the worktree detail) and still want
// to sit at the same inset, phone layout included.
export const PAGE_HEADER_PADDING =
  "px-6 pt-7 pb-4 phone:px-4 phone:pt-4 phone:pb-3";

export function PageHeader({
  eyebrow,
  title,
  trailing,
  tabs,
  watermark,
}: {
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  // Marks at the title row's right edge (a device chip, a terrier paw).
  trailing?: React.ReactNode;
  // A device tab bar (DeviceTabs) leading the header on the window's
  // traffic-light line, closer to the edge than a title ever sits:
  // everything under it is the picked device's.
  tabs?: React.ReactNode;
  // The doubutsu-only kanji glyph behind the header's right edge.
  watermark?: string;
}) {
  return (
    <header
      className={cn(
        "relative flex flex-col overflow-hidden border-b border-border",
        PAGE_HEADER_PADDING,
        tabs && "pt-4 phone:pt-3",
      )}
    >
      {/* Cancels the inset so the bar (which carries it as padding)
          scrolls out under the header's edge. Above the watermark, like
          the title: a long row's last tabs would run under the glyph. */}
      {tabs && (
        <div className="relative z-[1] -mx-6 mb-3 phone:-mx-4">{tabs}</div>
      )}
      <div className="relative z-[1] flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {eyebrow}
          </span>
          <h1 className="truncate text-lg font-medium tracking-tight">
            {title}
          </h1>
        </div>
        {trailing}
      </div>
      {watermark && (
        <span
          aria-hidden
          className="doubutsu-only pointer-events-none absolute -top-6 right-2 text-[120px] leading-none font-black text-[var(--doubutsu-watermark)] opacity-10 select-none"
        >
          {watermark}
        </span>
      )}
    </header>
  );
}
