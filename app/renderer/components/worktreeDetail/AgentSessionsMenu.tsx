import { Bot, Check, Copy, Unlink } from "lucide-react";
import { useCopied } from "@/components/ui/copy-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { RelativeDate } from "@/components/ui/relative-date";
import { StatusDot, TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useIdleAgents,
  useUnbindAgent,
} from "@/hooks/worktrees/useWorktreeMutations";
import {
  AGENT_STATE_VIEW,
  agentSessionsState,
  harnessLabel,
} from "@/lib/agentSessions";
import { cn } from "@/lib/utils";
import type { AgentSession, Worktree } from "@shared/schemas";
import { FooterVerb, LABEL_RANK } from "./footerFit";

// The agent sessions bound to the worktree (`sm agents`), as a footer
// verb in their combined state's tone that opens the list. Marking them
// idle is for a turn whose end no hook reported (Claude Code reports
// none when it is interrupted), and unbinding one is for a session
// that bound itself where it doesn't belong.
export function AgentSessionsMenu({
  worktree,
  sessions,
  busy,
}: {
  worktree: Worktree;
  sessions: AgentSession[];
  busy: boolean;
}) {
  const idle = useIdleAgents();
  const state = agentSessionsState(sessions);
  const view = AGENT_STATE_VIEW[state];
  const [only] = sessions;
  const label =
    sessions.length === 1 && only
      ? harnessLabel(only.harness)
      : `${sessions.length} agents`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <FooterVerb
            rank={LABEL_RANK.agents}
            icon={<Bot />}
            label={label}
            variant="ghost"
            className={cn("shrink-0", TONE_TEXT[view.tone])}
            tip={view.label}
          />
        }
      />
      <DropdownMenuContent align="end" side="top" className="min-w-56">
        {sessions.map((session) => {
          const sessionView = AGENT_STATE_VIEW[session.state];
          return (
            <div
              key={`${session.harness}:${session.session}`}
              className="flex items-center gap-3 px-2 py-1.5 text-xs"
            >
              <StatusDot
                tone={sessionView.tone}
                label={harnessLabel(session.harness)}
                className="text-xs"
              />
              <span className={cn("ml-auto", TONE_TEXT[sessionView.tone])}>
                {sessionView.label}
              </span>
              <span className="text-muted-foreground tabular-nums">
                <RelativeDate date={new Date(session.at).toISOString()} />
              </span>
              <SessionId id={session.session} />
              <UnbindButton worktree={worktree} session={session} busy={busy} />
            </div>
          );
        })}
        {state !== "idle" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={idle.isPending || busy}
              onClick={() =>
                idle.mutate({
                  projectId: worktree.projectId,
                  worktreeId: worktree.id,
                })
              }
            >
              Mark idle
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Copies the harness's own session id (what `claude --resume` and
// `codex resume` take), which the tooltip spells out.
function SessionId({ id }: { id: string }) {
  const [copied, copy] = useCopied(id);
  return (
    <SimpleTooltip tip={copied ? "Copied" : `Copy session id ${id}`}>
      <IconButton
        aria-label="Copy session id"
        onClick={copy}
        className="-my-1 p-0.5"
      >
        {copied ? (
          <Check className="size-3 text-foreground" />
        ) : (
          <Copy className="size-3" />
        )}
      </IconButton>
    </SimpleTooltip>
  );
}

function UnbindButton({
  worktree,
  session,
  busy,
}: {
  worktree: Worktree;
  session: AgentSession;
  busy: boolean;
}) {
  const unbind = useUnbindAgent();
  return (
    <SimpleTooltip tip="Unbind">
      <IconButton
        aria-label="Unbind"
        disabled={unbind.isPending || busy}
        onClick={() =>
          unbind.mutate({
            projectId: worktree.projectId,
            worktreeId: worktree.id,
            harness: session.harness,
            session: session.session,
          })
        }
        className="-my-1 p-0.5"
      >
        <Unlink className="size-3" />
      </IconButton>
    </SimpleTooltip>
  );
}
