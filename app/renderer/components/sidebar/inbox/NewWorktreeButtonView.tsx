// The inbox's New worktree button and its menu of targets, drawn
// (NewWorktreeButton works out the targets and creates).
import type { ComponentProps, CSSProperties } from "react";
import { Loader2, Plus } from "lucide-react";
import { ProjectIconView } from "@/components/shared/ProjectIconView";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MenuGroupView,
  MenuItemView,
  MenuLabelView,
  MenuSurfaceView,
} from "@/components/ui/menu-view";
import { DeviceBadge, type SidebarDeviceBadge } from "../DeviceBadgeView";

// The button, in every form it takes: creating outright, the trigger
// of the targets menu, or disabled with nowhere to create. Props pass
// through to the button, so a menu trigger can render it as its own
// element.
export function NewWorktreeButtonView({
  pending = false,
  className,
  ...props
}: ComponentProps<typeof Button> & {
  // A create in flight.
  pending?: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("w-full", className)}
      {...props}
    >
      {pending ? (
        <Loader2 aria-hidden className="animate-spin" />
      ) : (
        <Plus aria-hidden />
      )}
      {pending ? "Creating worktree…" : "New worktree"}
    </Button>
  );
}

// The label over the targets, the live menu's and the drawn one's.
export const NEW_WORKTREE_MENU_LABEL = "New worktree in… (⇧ to pick a base)";

// A target as the menu draws it: the project, and the peer it lives
// on (absent for this machine's).
export interface NewWorktreeTargetLook {
  key: string;
  name: string;
  // The project's logo, as ProjectIconView takes it.
  iconSrc: string | null | undefined;
  device: SidebarDeviceBadge | undefined;
}

// One target's item content, inside the live menu's item or the drawn
// one's.
export function NewWorktreeTargetContent({
  target,
}: {
  target: Omit<NewWorktreeTargetLook, "key">;
}) {
  return (
    <>
      <ProjectIconView name={target.name} src={target.iconSrc} />
      {target.name}
      {target.device && <DeviceBadge badge={target.device} />}
    </>
  );
}

// The targets menu drawn open, for a scene. The live one floats in a
// portal, outside the sidebar and its tokens, so a scene draws this one
// outside it too and places it under the button.
export function NewWorktreeMenuView({
  targets,
  className,
  style,
}: {
  targets: readonly NewWorktreeTargetLook[];
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <MenuSurfaceView className={className} style={style}>
      <MenuGroupView>
        <MenuLabelView>{NEW_WORKTREE_MENU_LABEL}</MenuLabelView>
        {targets.map((target) => (
          <MenuItemView key={target.key}>
            <NewWorktreeTargetContent target={target} />
          </MenuItemView>
        ))}
      </MenuGroupView>
    </MenuSurfaceView>
  );
}
