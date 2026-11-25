// The sidebar's footer (SidebarFooterView): the layout toggle, and the
// app-level actions. A hostless client has no local tree to arrange,
// so its bar carries the toggle and the page-nav cluster.
import { useBinding } from "@/hooks/ui/useKeymap";
import { startGuide, useGuideChoices } from "@/hooks/useGuide";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useClientFlag } from "@/hooks/config/useSidebarMarks";
import { useLiveCounts } from "@/hooks/live/useLiveActivity";
import {
  useSetSidebarView,
  useSidebarView,
} from "@/hooks/projects/useSidebarView";
import { useStagedUpdates } from "@/hooks/system/useUpdater";
import { pluralize } from "@shigomori/contracts/words";
import { agentsNeedYou } from "@shigomori/ui/lib/agentNeeds.ts";
import { useWaitingAgents } from "@/lib/agentWatch";
import { useHasLocalHost } from "@/lib/localHost";
import { useApi } from "@/lib/runtime/pageApi";
import {
  type LiveActivityMark,
  SidebarFooterView,
  SidebarGuideMenuView,
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
  const counts = useLiveCounts();
  const waiting = useWaitingAgents().length;
  const needsYou = useClientFlag("markAgentsWaiting") && waiting > 0;
  const kinds: [number, string, LiveActivityMark["tone"]][] = [
    [counts.scripts, "script", "violet"],
    [counts.terminals, "terminal", counts.terminalsBusy ? "sky" : "slate"],
    [counts.forwards, "port forward", "emerald"],
    [counts.mirrors, "mirror", "indigo"],
  ];
  const live: LiveActivityMark[] = [
    ...(needsYou
      ? [{ tone: "amber" as const, label: agentsNeedYou(waiting) }]
      : []),
    ...kinds
      .filter(([count]) => count > 0)
      .map(([count, noun, tone]) => ({ tone, label: pluralize(count, noun) })),
  ];
  const guides = useGuideChoices();
  const api = useApi();
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
          {guides !== undefined && guides.harnesses.length > 0 && (
            <SidebarGuideMenuView
              choices={guides}
              onPick={(start) => startGuide(api, start)}
            />
          )}
          <SidebarNavActionsView
            hasLocalHost={hasLocalHost}
            pathname={pathname}
            live={live}
            updateReady={updateReady}
            onNavigate={(to) => void navigate({ to })}
          />
        </>
      }
    />
  );
}
