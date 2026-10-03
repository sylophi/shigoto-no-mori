// The phone layout's primary navigation (PhoneTabBarView). A tab
// lights on its page exactly (the rule SidebarNavActions follows: a
// worktree under /devices/$deviceId is ordinary work, not a device
// page), and for everything else the forest tab the layout preference
// names lights, since every other page is reached from one of them
// (the forest page keeps that preference in step with its route).
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useSidebarView } from "@/hooks/projects/useSidebarView";
import { useStagedUpdates } from "@/hooks/system/useUpdater";
import { forestTabFor, PhoneTabBarView, TABS } from "./PhoneTabBarView";

export function PhoneTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const view = useSidebarView();
  const updateReady = Object.keys(useStagedUpdates()).length > 0;
  const active =
    TABS.find((tab) => tab.pathname === pathname)?.pathname ??
    forestTabFor(view).pathname;
  return (
    <PhoneTabBarView
      active={active}
      updateReady={updateReady}
      onNavigate={(tab) => void navigate(tab.to)}
    />
  );
}
