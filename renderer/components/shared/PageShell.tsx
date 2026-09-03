// The full-page column shared by the top-level pages: a PageHeader over
// a scrollable body. One component so the scroll-region and
// body-column class strings live in exactly one place. The body runs
// the page's full width. A prose-shaped page caps its own content.
import type React from "react";
import { PageHeader } from "./PageHeader";

export function PageShell({
  page,
  eyebrow,
  title,
  watermark,
  children,
}: {
  // The data-doubutsu-page marker picking the canvas wallpaper, absent
  // for pages without one.
  page?: string;
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  watermark: string;
  children: React.ReactNode;
}) {
  return (
    <div data-doubutsu-page={page} className="flex h-full flex-col">
      <PageHeader eyebrow={eyebrow} title={title} watermark={watermark} />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}
