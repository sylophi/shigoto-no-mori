import { Bot } from "lucide-react";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { needLine } from "@/lib/agentNeeds";
import { AGENT_STATE_VIEW, waitingSession } from "@/lib/agentSessions";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shigomori/contracts/schemas";

// A worktree's row while one of its agent sessions waits on you (a
// permission prompt or a question): the agent's icon and "Needs you" in
// amber, the footer's agents verb in its waiting tone. Its tooltip says
// what the agent asks. It holds still, like a failed script's mark: it
// is news, not progress. Drawn while the sidebar marks waiting agents
// (useSidebarMarks).
export function AgentWaitingMarkView({ worktree }: { worktree: Worktree }) {
  const session = waitingSession(worktree.agentSessions);
  if (!session) return null;
  const line = needLine(session);
  const view = AGENT_STATE_VIEW.waiting;
  return (
    <SimpleTooltip tip={line}>
      <span
        aria-label={line}
        className={cn(
          "inline-flex shrink-0 items-center gap-0.5 text-3xs font-medium",
          TONE_TEXT[view.tone],
        )}
      >
        <Bot aria-hidden className="size-3" />
        {view.label}
      </span>
    </SimpleTooltip>
  );
}
