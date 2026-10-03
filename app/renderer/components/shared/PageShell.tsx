// The full-page column shared by the top-level pages: a PageHeader over
// a scrollable body. One component so the scroll-region and
// body-column class strings live in exactly one place. The body runs
// the page's full width. A prose-shaped page caps its own content.
// Its header has no tab bar, so it draws PageHeaderView directly and
// reads nothing off the window, which keeps the shell usable in a view.
import type React from "react";
import { PageHeaderView } from "./PageHeaderView";
import { PAGE_BODY } from "./pageInsets";

export { PAGE_BODY };

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
      <PageHeaderView eyebrow={eyebrow} title={title} watermark={watermark} />
      <div className={PAGE_BODY}>
        <div className="flex flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}
