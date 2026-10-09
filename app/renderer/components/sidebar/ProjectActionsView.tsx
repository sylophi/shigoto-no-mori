// A project header's `+` and `…` (ProjectGroupActions binds them): the
// quick create, and the action list under a menu, revealed by hover
// (and by keyboard focus or an open menu), always shown on a phone.
import type { ReactNode, RefObject } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  PROJECT_ACTION_HOOKS,
  PROJECT_MENU_TRIGGER_CLASS,
} from "./sidebarChrome";

export function ProjectActionsView({
  name,
  isHovered,
  triggerRef,
  onOpenChange,
  quickCreate,
  menu,
}: {
  name: string;
  isHovered: boolean;
  // The `…` trigger, so the header's right-click can pop the same menu.
  triggerRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  // The `+` (QuickCreateButton), and the menu's items.
  quickCreate: ReactNode;
  menu: ReactNode;
}) {
  return (
    <>
      {quickCreate}
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              aria-label={`More actions for ${name}`}
              {...PROJECT_ACTION_HOOKS}
              className={cn(
                PROJECT_MENU_TRIGGER_CLASS,
                isHovered ? "opacity-100" : "opacity-0",
              )}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={2}>
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
