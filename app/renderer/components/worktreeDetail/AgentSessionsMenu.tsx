import type { ReactNode } from "react";
import { Bot, Check, Copy, Play, Unlink } from "lucide-react";
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
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  useIdleAgents,
  useResumeAgent,
  useUnbindAgent,
} from "@/hooks/worktrees/useWorktreeMutations";
import {
  AGENT_STATE_VIEW,
  agentSessionsState,
  canResume,
  harnessLabel,
  waitingSession,
} from "@/lib/agentSessions";
import { needLine, needView, stateLabel } from "@/lib/agentNeeds";
import { cn } from "@/lib/utils";
import type { AgentSession, Worktree } from "@shared/schemas";
import { FooterVerb, LABEL_RANK } from "./footerFit";

// The agent sessions bound to the worktree (`sm agents`), as a footer
// verb in their combined state's tone that opens the list. Marking them
// idle is for a turn whose end no hook reported (Claude Code reports
// none when it is interrupted), and unbinding one is for a session
// that bound itself where it doesn't belong. An idle session on this
// machine can be resumed in a terminal.
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
  const waiting = waitingSession(sessions);
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
            tip={waiting ? needLine(waiting) : view.label}
          />
        }
      />
      <DropdownMenuContent align="end" side="top" className="w-80">
        {sessions.map((session) => (
          <SessionRow
            key={`${session.harness}:${session.session}`}
            worktree={worktree}
            session={session}
            busy={busy}
          />
        ))}
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

// One session: what it is about (its title, else its harness) in its
// state's dot, its state under that (as a sentence about its harness
// once a title leads, led by the icon of the prompt it waits on) with
// when it changed, then what that prompt is about, or the message its
// last turn ended on.
function SessionRow({
  worktree,
  session,
  busy,
}: {
  worktree: Worktree;
  session: AgentSession;
  busy: boolean;
}) {
  const view = AGENT_STATE_VIEW[session.state];
  const harness = harnessLabel(session.harness);
  const label = session.title ?? harness;
  const need = session.state === "waiting" ? needView(session) : undefined;
  const detail = need
    ? need.text
    : session.state === "idle"
      ? session.message
      : undefined;
  // Under the harness's name (no title), the sentence goes without it.
  const sentence = stateLabel(session, session.title !== undefined);
  const { remote } = useHostScope();
  const resume = useResumeAgent();
  const unbind = useUnbindAgent();
  const vars = {
    projectId: worktree.projectId,
    worktreeId: worktree.id,
    harness: session.harness,
    session: session.session,
  };
  // Resuming a session that isn't idle would run it twice, the second
  // copy beside one still mid-turn wherever it runs.
  const resumable =
    session.state === "idle" && canResume(session.harness) && !remote;
  return (
    <div className="space-y-0.5 px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <StatusDot
          tone={view.tone}
          label={
            <SimpleTooltip whenTruncated tip={label}>
              <span className="truncate">{label}</span>
            </SimpleTooltip>
          }
          className="min-w-0 flex-1 text-xs"
        />
        <SessionId id={session.session} />
        {resumable && (
          <SessionAction
            label="Resume in terminal"
            icon={<Play className="size-3" />}
            disabled={resume.isPending || busy}
            onClick={() => resume.mutate(vars)}
          />
        )}
        <SessionAction
          label="Unbind"
          icon={<Unlink className="size-3" />}
          disabled={unbind.isPending || busy}
          onClick={() => unbind.mutate(vars)}
        />
      </div>
      <p className="flex gap-2 pl-3 text-2xs">
        <span className={cn("flex items-center gap-1", TONE_TEXT[view.tone])}>
          {need && <need.Icon aria-hidden className="size-3 shrink-0" />}
          {sentence}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          <RelativeDate date={new Date(session.at).toISOString()} />
        </span>
      </p>
      {detail && (
        <p className="line-clamp-3 pl-3 text-2xs break-words text-foreground/80">
          {detail}
        </p>
      )}
    </div>
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

function SessionAction({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <SimpleTooltip tip={label}>
      <IconButton
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="-my-1 p-0.5"
      >
        {icon}
      </IconButton>
    </SimpleTooltip>
  );
}
