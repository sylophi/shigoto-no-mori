// The full-page header shared by the top-level pages (Settings, Tidy,
// Devices, the project pages, and the web shell's pages): an eyebrow
// line, the page title, optional trailing marks, an optional device
// tab bar leading it, and the doubutsu watermark glyph. One component
// so the header chrome, the inset and the tab wiring live in exactly
// one place (PageHeaderView draws it).
import type React from "react";
import { hasLocalHost } from "@/lib/localHost";
import { PageHeaderView } from "./PageHeaderView";

export { PAGE_HEADER_PADDING } from "./pageInsets";

// The header (PageHeaderView), told whether the window has a local
// host for its tab bar.
export function PageHeader(
  props: Omit<React.ComponentProps<typeof PageHeaderView>, "hasLocalHost">,
) {
  return <PageHeaderView {...props} hasLocalHost={hasLocalHost} />;
}
