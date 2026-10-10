// A page's own list in the sidebar's place (SidebarTakeover portals it
// into the slot), led by the way back off the page, and the slot it
// lands in, which arrives from the right as the forest steps aside.
import type { ReactNode, Ref } from "react";
import { BackButton } from "@shigomori/ui/primitives/back-button.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { ARRIVE_FROM } from "./sidebarChrome";

export function SidebarTakeoverView({
  back,
  actions,
  children,
}: {
  back: { label: string; onClick: () => void };
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pb-1">
        <BackButton
          label={back.label}
          onClick={back.onClick}
          className="ml-0 min-w-0 flex-1 justify-start"
        />
        {actions}
      </div>
      {children}
    </div>
  );
}

export function SidebarTakeoverSlotView({
  slotRef,
  children,
}: {
  slotRef?: Ref<HTMLDivElement>;
  // A takeover drawn in place, where nothing portals (a scene).
  children?: ReactNode;
}) {
  return (
    <div
      ref={slotRef}
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto empty:hidden",
        ARRIVE_FROM.right,
      )}
    >
      {children}
    </div>
  );
}
