import { FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { hasLocalHost } from "@/lib/localHost";
import { PROJECT_ACTION_HOOKS, SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

// Opens the add-project dialog. `outline` puts it on the button
// primitive at New worktree's height, so beside that button the two read
// as one row of create buttons rather than a button and a stray icon.
// The primitive, not just its classes: doubutsu restyles that row by its
// data-slot/data-variant. The bare one borrows a project header's phone
// hooks, since a phone has no hover to reveal its fill.
//
// ⌘N is a native menu accelerator, so only the desktop app has it.
export function AddProjectButton({ outline = false }: { outline?: boolean }) {
  const { openAddProject } = useOverlays();
  // aria-keyshortcuts restores the AT-audible shortcut hints the old
  // native titles carried; Base UI tooltips are visual-only.
  const props = {
    type: "button",
    onClick: () => openAddProject(),
    "aria-label": "Add project",
    "aria-keyshortcuts": hasLocalHost ? "Meta+N" : undefined,
  } as const;
  const icon = <FolderPlus className="size-3.5" />;
  return (
    <SimpleTooltip tip={hasLocalHost ? "Add project (⌘N)" : "Add project"}>
      {outline ? (
        <Button variant="outline" size="icon-sm" {...props}>
          {icon}
        </Button>
      ) : (
        <button
          className={SIDEBAR_ICON_BUTTON}
          {...PROJECT_ACTION_HOOKS}
          {...props}
        >
          {icon}
        </button>
      )}
    </SimpleTooltip>
  );
}
