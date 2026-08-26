// The full-page header shared by the top-level pages (Settings, Tidy,
// the remote forest, and the web shell's pages): an eyebrow line, the
// page title, optional status and actions slots, and the doubutsu
// watermark glyph. One component so the watermark class string and the
// header chrome live in exactly one place.
import type React from "react";

// Two complete class strings rather than an interpolated padding slot:
// Tailwind's scanner only sees full utility tokens, so the variant
// classes must appear verbatim. Desktop pages sit under the window
// chrome and breathe with pt-7, the web pages render below the web
// shell's own top bar and use pt-5.
const HEADER_CLASS = {
  "pt-7":
    "relative flex items-center gap-3 overflow-hidden border-b border-border px-6 pt-7 pb-4",
  "pt-5":
    "relative flex items-center gap-3 overflow-hidden border-b border-border px-6 pt-5 pb-4",
} as const;

export function PageHeader({
  eyebrow,
  title,
  watermark,
  status,
  actions,
  topPadding = "pt-7",
}: {
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  // The doubutsu-only kanji glyph behind the header's right edge.
  watermark: string;
  // Rendered beside the title (a status dot).
  status?: React.ReactNode;
  // Pinned to the right edge (a settings toggle).
  actions?: React.ReactNode;
  topPadding?: keyof typeof HEADER_CLASS;
}) {
  return (
    <header className={HEADER_CLASS[topPadding]}>
      <div className="relative z-[1] flex min-w-0 flex-col">
        <span className="truncate text-xs text-muted-foreground">
          {eyebrow}
        </span>
        <h1 className="truncate text-lg font-medium tracking-tight">{title}</h1>
      </div>
      {status && <div className="relative z-[1] shrink-0">{status}</div>}
      {actions && (
        <div className="relative z-[1] ml-auto shrink-0">{actions}</div>
      )}
      <span
        aria-hidden
        className="doubutsu-only pointer-events-none absolute -top-6 right-2 text-[120px] leading-none font-black text-[var(--doubutsu-watermark)] opacity-10 select-none"
      >
        {watermark}
      </span>
    </header>
  );
}
