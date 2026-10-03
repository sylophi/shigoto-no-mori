// A project header's `+` and `…`, drawn (ProjectGroupActions and
// QuickCreateButton give them their device, their create and their
// menu). A scene draws them as they rest, the menu shut.
import type { ComponentProps } from "react";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PROJECT_ACTION_HOOKS,
  PROJECT_MENU_TRIGGER_CLASS,
} from "./sidebarChrome";

// The quick create's label, naming the device when the header spans
// several.
export function quickCreateLabel(name: string, deviceLabel?: string): string {
  return deviceLabel
    ? `Quick-create worktree in ${name} on ${deviceLabel}`
    : `Quick-create worktree in ${name}`;
}

// The `+`: hover-revealed like the `…` beside it (and on keyboard
// focus), always shown on a phone, where there is no hover.
export function QuickCreateButtonView({
  label,
  creating = false,
  isHovered,
  onClick,
}: {
  label: string;
  creating?: boolean;
  isHovered: boolean;
  onClick?: ComponentProps<"button">["onClick"];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={creating}
      aria-label={label}
      title={label}
      {...PROJECT_ACTION_HOOKS}
      className={cn(
        PROJECT_MENU_TRIGGER_CLASS,
        "disabled:cursor-not-allowed disabled:opacity-100 aria-busy:opacity-100",
        // Hover is a pointer's idea of "reveal". Tabbing here is the
        // keyboard's, and an invisible button under the focus ring is
        // a dead end, so focus shows it the same way an open menu
        // already does (aria-expanded above).
        isHovered ? "opacity-100" : "opacity-0 focus-visible:opacity-100",
      )}
      aria-busy={creating}
    >
      {creating ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Plus className="size-3.5" />
      )}
    </button>
  );
}

// The `…`, which the live menu renders through its own trigger.
export function ProjectMenuTriggerButton({
  name,
  isHovered,
  ...props
}: ComponentProps<"button"> & { name: string; isHovered: boolean }) {
  return (
    <button
      type="button"
      aria-label={`More actions for ${name}`}
      {...PROJECT_ACTION_HOOKS}
      className={cn(
        PROJECT_MENU_TRIGGER_CLASS,
        isHovered ? "opacity-100" : "opacity-0",
      )}
      {...props}
    >
      <MoreHorizontal className="size-3.5" />
    </button>
  );
}

// Both, at rest. A header with nowhere to create (every device asleep,
// or a missing checkout) has no `+`.
export function ProjectGroupActionsView({
  name,
  createLabel,
  isHovered,
}: {
  name: string;
  // The `+`'s label (quickCreateLabel), undefined for no `+`.
  createLabel: string | undefined;
  isHovered: boolean;
}) {
  return (
    <>
      {createLabel !== undefined && (
        <QuickCreateButtonView label={createLabel} isHovered={isHovered} />
      )}
      <ProjectMenuTriggerButton
        name={name}
        isHovered={isHovered}
        aria-haspopup="menu"
      />
    </>
  );
}
