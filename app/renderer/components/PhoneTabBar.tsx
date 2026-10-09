// The phone layout's primary navigation (PhoneTabBarView), on the
// route and the forest view the layout preference names.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { PhoneTabBarView } from "@/components/PhoneTabBarView";
import { useSidebarView } from "@/hooks/projects/useSidebarView";
import { useStagedUpdates } from "@/hooks/system/useUpdater";

export function PhoneTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <PhoneTabBarView
      pathname={pathname}
      view={useSidebarView()}
      updateReady={Object.keys(useStagedUpdates()).length > 0}
      onNavigate={(to) => void navigate(to)}
    />
  );
}
