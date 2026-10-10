import { Loader2, Plus } from "lucide-react";
import { cn } from "../../lib/utils.ts";
import type { MouseEvent } from "react";
import {
  PROJECT_ACTION_HOOKS,
  PROJECT_MENU_TRIGGER_CLASS,
} from "./sidebarChrome.ts";

// The project header's `+`: a quick create off the default branch, or
// the full form on a modified click (QuickCreateButton). Hover-revealed
// like the `…` beside it (and on keyboard focus), always shown on a
// phone, where there is no hover.
export function QuickCreateButtonView({
  name,
  isHovered,
  deviceLabel,
  creating,
  onClick,
}: {
  name: string;
  isHovered: boolean;
  // Names the device in the label when the header spans several.
  deviceLabel?: string;
  creating: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const label = deviceLabel
    ? `Quick-create worktree in ${name} on ${deviceLabel}`
    : `Quick-create worktree in ${name}`;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={creating}
      aria-label={label}
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
