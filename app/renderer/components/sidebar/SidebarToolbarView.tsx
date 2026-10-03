// The tree's toolbar, drawn (SidebarToolbar gives it its menus): the
// way back or the project sort at the left end, add project at the
// right, and inside a project the worktree sort beside it.
import type { ComponentProps, ReactNode } from "react";
import { ArrowUpDown } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

export function SidebarToolbarView({
  back,
  sort,
  addProject,
}: {
  // Inside a project: the way back to the list of projects. Absent on
  // the list itself.
  back: { onBack: () => void } | undefined;
  // The sort control: the project sort at the left end on the list (a
  // hostless client has none), the project's worktree sort at the
  // right end inside one.
  sort: ReactNode;
  addProject: ReactNode;
}) {
  return (
    // Same left/right split as the footer below it: the control that
    // changes what the list shows sits left, the action sits right.
    <div className="flex items-center gap-1 px-2 pb-1">
      {back ? (
        <BackButton label="Projects" onClick={back.onBack} className="ml-0" />
      ) : (
        sort
      )}
      <div className="flex-1" />
      {back && sort}
      {addProject}
    </div>
  );
}

// A sort menu's trigger, which the live menu (SidebarToolbar) renders
// through its own trigger and a scene draws closed as it is.
export function SortTriggerButton({
  tip,
  ...props
}: ComponentProps<"button"> & {
  // The trigger's tooltip and accessible name.
  tip: string;
}) {
  return (
    <button
      type="button"
      aria-label={tip}
      className={SIDEBAR_ICON_BUTTON}
      {...props}
    >
      <ArrowUpDown className="size-3.5" />
    </button>
  );
}

// A sort menu shut, for a scene: the trigger in the wrapper the live
// one hangs its tooltip on.
export function SortTriggerView({ tip }: { tip: string }) {
  return (
    <span className="inline-flex">
      <SortTriggerButton tip={tip} aria-haspopup="menu" />
    </span>
  );
}
