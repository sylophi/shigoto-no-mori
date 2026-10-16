// The sidebar's footer (SidebarFooterView): the layout toggle, and the
// app-level actions. A hostless client has no local tree to arrange,
// so its bar carries the toggle and the page-nav cluster.
import { showAroundLabel } from "@shigomori/contracts/modules/guide";
import { useBinding } from "@/hooks/ui/useKeymap";
import { useGuideHarnesses } from "@/hooks/useGuide";
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
import { useHasLocalHost } from "@/lib/localHost";
import { useApi } from "@/lib/runtime/pageApi";
import {
  SidebarFooterView,
  SidebarGuideButtonView,
  SidebarNavActionsView,
  SidebarViewToggleView,
} from "@shigomori/ui/views/sidebar/SidebarFooterView.tsx";

interface SidebarFooterProps {
  arrangeMode: boolean;
  onToggleArrange: () => void;
}

export function SidebarFooter({
  arrangeMode,
  onToggleArrange,
}: SidebarFooterProps) {
  const hasLocalHost = useHasLocalHost();
  const view = useSidebarView();
  const { mutate: setView } = useSetSidebarView();
  const layoutKeys = useBinding("sidebarLayout");
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const updateReady = Object.keys(useStagedUpdates()).length > 0;
  const running = useLiveCount();
  const waiting = useWaitingAgents().length;
  const needsYou = useMarkAgentsWaiting() && waiting > 0;
  const api = useApi();
  const [harness, ...more] = useGuideHarnesses() ?? [];
  return (
    <SidebarFooterView
      onDoneArranging={
        hasLocalHost && arrangeMode ? onToggleArrange : undefined
      }
      toggle={
        <SidebarViewToggleView
          view={view}
          onChange={setView}
          keys={layoutKeys.aria}
        />
      }
      actions={
        <>
          {harness !== undefined && (
            <SidebarGuideButtonView
              label={
                more.length === 0 ? showAroundLabel(harness) : "Show me around"
              }
              onClick={(at) => void api.run(api.menu.showAround(at))}
            />
          )}
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
        </>
      }
    />
  );
}
