// The full-page column shared by the top-level pages: a PageHeader over
// a scrollable, width-capped body. One component so the scroll-region
// and body-column class strings live in exactly one place.
import type React from "react";
import { PageHeader } from "./PageHeader";

// Two complete class strings rather than an interpolated gap slot:
// Tailwind's scanner only sees full utility tokens (same rule as
// PageHeader's padding variants).
const BODY_CLASS = {
  "gap-6": "flex max-w-3xl flex-col gap-6",
  "gap-10": "flex max-w-3xl flex-col gap-10",
} as const;

export function PageShell({
  page,
  eyebrow,
  title,
  watermark,
  status,
  actions,
  full = false,
  gap = "gap-6",
  children,
}: {
  // The data-doubutsu-page marker picking the canvas wallpaper, absent
  // for pages without one.
  page?: string;
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  watermark: string;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  // Default: children flow in the shell's scrollable column. `full`
  // hands the whole below-header area to the children instead, for a
  // body that brings its own scroll region and pinned footer.
  full?: boolean;
  gap?: keyof typeof BODY_CLASS;
  children: React.ReactNode;
}) {
  return (
    <div data-doubutsu-page={page} className="flex h-full flex-col">
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        watermark={watermark}
        status={status}
        actions={actions}
      />
      {full ? (
        children
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className={BODY_CLASS[gap]}>{children}</div>
        </div>
      )}
    </div>
  );
}
