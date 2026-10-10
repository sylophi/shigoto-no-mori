// The sidebar's footer (SidebarFooterView): the layout toggle, and the
// app-level actions. A hostless client has no local tree to arrange,
// so its bar carries the toggle and the page-nav cluster.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useMarkAgentsWaiting } from "@/hooks/config/useSidebarMarks";
import { useLiveCount } from "@/hooks/live/useLiveActivity";
import {
  useSetSidebarView,
  useSidebarView,
} from "@/hooks/projects/useSidebarView";
import { useStagedUpdates } from "@/hooks/system/useUpdater";
import { agentsNeedYou } from "@shigomori/ui/lib/agentNeeds.ts";
import { useWaitingAgents } from "@/lib/agentWatch";
import { hasLocalHost } from "@/lib/localHost";
import {
  SidebarFooterView,
  SidebarNavActionsView,
  SidebarViewToggleView,
} from "./SidebarFooterView";

interface SidebarFooterProps {
  arrangeMode: boolean;
  onToggleArrange: () => void;
}

export function SidebarFooter({
  arrangeMode,
  onToggleArrange,
}: SidebarFooterProps) {
  const view = useSidebarView();
  const { mutate: setView } = useSetSidebarView();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const updateReady = Object.keys(useStagedUpdates()).length > 0;
  const running = useLiveCount();
  const waiting = useWaitingAgents().length;
  const needsYou = useMarkAgentsWaiting() && waiting > 0;
  return (
    <SidebarFooterView
      onDoneArranging={
        hasLocalHost && arrangeMode ? onToggleArrange : undefined
      }
      toggle={<SidebarViewToggleView view={view} onChange={setView} />}
      actions={
        <SidebarNavActionsView
          hasLocalHost={hasLocalHost}
          pathname={pathname}
          live={{
            label: needsYou
              ? `Live (${agentsNeedYou(waiting)})`
              : running > 0
                ? `Live (${running} running)`
                : "Live",
            dot: needsYou ? "amber" : running > 0 ? "emerald" : null,
          }}
          updateReady={updateReady}
          onNavigate={(to) => void navigate({ to })}
        />
      }
    />
  );
}
