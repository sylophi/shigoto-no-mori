import {
  useSetSidebarView,
  useSidebarView,
} from "@/hooks/projects/useSidebarView";
import { SidebarViewToggleView } from "./SidebarFooterView";

// The inbox / projects flip (SidebarViewToggleView), over the saved
// preference.
export function SidebarViewToggle() {
  const view = useSidebarView();
  const { mutate: setView } = useSetSidebarView();
  return <SidebarViewToggleView view={view} onChange={setView} />;
}
