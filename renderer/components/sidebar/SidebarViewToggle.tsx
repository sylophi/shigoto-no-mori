import { Inbox, ListTree } from "lucide-react";
import type { SidebarView } from "@shared/schemas";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control";
import {
  useSetSidebarView,
  useSidebarView,
} from "@/hooks/projects/useSidebarView";

const VIEW_OPTIONS = [
  {
    value: "inbox",
    label: <Inbox aria-hidden className="size-3.5" />,
    title: "One list across every project, newest work first",
  },
  {
    value: "projects",
    label: <ListTree aria-hidden className="size-3.5" />,
    title: "Group worktrees by project",
  },
] as const satisfies ReadonlyArray<SegmentedOption<SidebarView>>;

// The inbox / projects flip. Both shells' footers carry it. The phone
// layout has the two views as tabs instead. aria-keyshortcuts restores
// the AT-audible shortcut hint the old native title carried; Base UI
// tooltips are visual-only.
export function SidebarViewToggle() {
  const view = useSidebarView();
  const { mutate: setView } = useSetSidebarView();
  return (
    <SegmentedControl<SidebarView>
      value={view}
      onChange={setView}
      options={VIEW_OPTIONS}
      aria-label="Sidebar layout"
      aria-keyshortcuts="Tab"
      optionClassName="px-1.5 py-1"
    />
  );
}
