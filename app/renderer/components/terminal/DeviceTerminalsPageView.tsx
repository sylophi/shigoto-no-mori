// A device's own terminals, the ones no worktree holds, on a page of
// their own: the device's name over the tabs.
import type { ReactNode } from "react";
import { PageHeaderView } from "@shigomori/ui/views/shared/PageHeaderView.tsx";

export function DeviceTerminalsPageView({
  deviceName,
  children,
}: {
  deviceName: string;
  // The tabs (TerminalTabs).
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <PageHeaderView eyebrow={deviceName} title="Terminals" watermark="端末" />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
