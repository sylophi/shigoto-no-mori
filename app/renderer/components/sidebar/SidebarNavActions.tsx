// The footer's page-nav cluster (SidebarNavActionsView), lit by the
// route on screen and dotted while an update waits.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useStagedUpdates } from "@/hooks/system/useUpdater";
import { hasLocalHost } from "@/lib/localHost";
import { SidebarNavActionsView } from "./SidebarFooterView";

export function SidebarNavActions() {
  const updateReady = Object.keys(useStagedUpdates()).length > 0;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <SidebarNavActionsView
      hasLocalHost={hasLocalHost}
      updateReady={updateReady}
      activePath={pathname}
      onNavigate={(to) => void navigate({ to })}
    />
  );
}
