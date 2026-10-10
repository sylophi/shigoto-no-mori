import type { ReactNode } from "react";
import { Bot, Check, Copy, Play, Unlink } from "lucide-react";
import { useCopied } from "@shigomori/ui/primitives/copy-button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";
import { RelativeDate } from "@shigomori/ui/primitives/relative-date.tsx";
import { StatusDot, TONE_TEXT } from "@shigomori/ui/primitives/status-dot.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import {
  AGENT_STATE_VIEW,
  agentSessionsState,
  harnessLabel,
  waitingSession,
} from "@shigomori/ui/lib/agentSessions.ts";
import {
  needLine,
  needView,
  stateLabel,
} from "@shigomori/ui/lib/agentNeeds.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";
import type { AgentSession } from "@shigomori/contracts/schemas";
import { FooterVerbView, LABEL_RANK } from "./FooterVerbView";

// The agent sessions bound to the worktree (`sm agents`), as a footer
// verb in their combined state's tone that opens the list. Marking them
// idle is for a turn whose end no hook reported (Claude Code reports
// none when it is interrupted), and unbinding one is for a session
// that bound itself where it doesn't belong. An idle session on this
// machine can be resumed in a terminal.
export function AgentSessionsMenuView({
  sessions,
  rows,
  markIdle,
}: {
  sessions: readonly AgentSession[];
  // A row per session (SessionRowView).
  rows: ReactNode;
  // While any session is busy: Mark idle, off while it or a delete is
  // under way.
  markIdle: { disabled: boolean; onClick: () => void };
}) {
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
          <FooterVerbView
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
        {rows}
        {state !== "idle" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={markIdle.disabled}
              onClick={markIdle.onClick}
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
export function SessionRowView({
  session,
  resumable,
  resumeDisabled,
  unbindDisabled,
  onResume,
  onUnbind,
}: {
  session: AgentSession;
  // An idle session on this machine, whose harness resumes.
  resumable: boolean;
  resumeDisabled: boolean;
  unbindDisabled: boolean;
  onResume: () => void;
  onUnbind: () => void;
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
            disabled={resumeDisabled}
            onClick={onResume}
          />
        )}
        <SessionAction
          label="Unbind"
          icon={<Unlink className="size-3" />}
          disabled={unbindDisabled}
          onClick={onUnbind}
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
