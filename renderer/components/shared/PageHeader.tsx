// The full-page header shared by the top-level pages (Settings, Tidy,
// Devices, and the web shell's pages): an eyebrow line, the page title,
// and the doubutsu watermark glyph. One component so the watermark class
// string and the header chrome live in exactly one place.
import type React from "react";

// One padding for both shells: the desktop pages sit under the window
// chrome, and since the web shell became a sidebar layout its pages
// have the same open canvas above them (the former slim-top-bar shell
// carried a pt-5 variant that no longer has a caller).
// The header's padding on its own, for the pages that draw a header of
// their own shape (the diff pages, the worktree detail) and still want
// to sit at the same inset, phone layout included.
export const PAGE_HEADER_PADDING =
  "px-6 pt-7 pb-4 phone:px-4 phone:pt-4 phone:pb-3";

const HEADER_CLASS = `relative flex items-center gap-3 overflow-hidden border-b border-border ${PAGE_HEADER_PADDING}`;

export function PageHeader({
  eyebrow,
  title,
  watermark,
}: {
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  // The doubutsu-only kanji glyph behind the header's right edge.
  watermark: string;
}) {
  return (
    <header className={HEADER_CLASS}>
      <div className="relative z-[1] flex min-w-0 flex-col">
        <span className="truncate text-xs text-muted-foreground">
          {eyebrow}
        </span>
        <h1 className="truncate text-lg font-medium tracking-tight">{title}</h1>
      </div>
      <span
        aria-hidden
        className="doubutsu-only pointer-events-none absolute -top-6 right-2 text-[120px] leading-none font-black text-[var(--doubutsu-watermark)] opacity-10 select-none"
      >
        {watermark}
      </span>
    </header>
  );
}
