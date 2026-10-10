import type { ReactNode } from "react";
import {
  Cable,
  ExternalLink as ExternalLinkIcon,
  Loader2,
  RefreshCw,
  RotateCw,
  Settings2,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import type { AgentSession } from "@shigomori/contracts/schemas";
import { DeviceGlyphView } from "@shigomori/ui/views/shared/DeviceGlyphView.tsx";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { RelativeDate } from "@shigomori/ui/primitives/relative-date.tsx";
import {
  StatusDot,
  TONE_TEXT,
  type StatusTone,
} from "@shigomori/ui/primitives/status-dot.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { useNow } from "@shigomori/ui/hooks/useNow.ts";
import { needView } from "@/lib/agentNeeds";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@shigomori/ui/lib/utils.ts";

// The live things a card lists, each a block with its status and its
// actions as labelled buttons (LiveBlockView, at the end). LiveItems.tsx
// binds each to its runner, mirror or forward.

// How long something has been up, coarse like the app's relative
// times: "up 12m", "up 3h 5m", "up 2d", or "just started".
function uptime(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `up ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 ? `up ${hours}h ${minutes % 60}m` : `up ${hours}h`;
  }
  return `up ${Math.floor(hours / 24)}d`;
}

export function UptimeView({ since }: { since: number }) {
  const now = useNow();
  return (
    <SimpleTooltip tip={`Started ${new Date(since).toLocaleString()}`}>
      <span className="tabular">{uptime(since, now)}</span>
    </SimpleTooltip>
  );
}

// A ghost button on an item's muted fill. v1's dark ghost hover is that
// same fill, so the hover lifts it the way the outline button does.
const ON_FILL = "dark:hover:bg-input/50";

// A device inline: its glyph and its name.
export function DeviceNameView({
  icon,
  name,
}: {
  icon: DeviceIcon;
  name: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <DeviceGlyphView icon={icon} className="size-3.5" />
      <SimpleTooltip whenTruncated tip={name}>
        <span className="truncate">{name}</span>
      </SimpleTooltip>
    </span>
  );
}

// An agent waiting on you: the icon of the prompt it waits on, what it
// wants and what about, and since when. Answering happens where the
// agent runs, so the card's header (the way to the worktree) is the one
// thing to do about it.
export function AgentItemView({ session }: { session: AgentSession }) {
  const { Icon, sentence, text } = needView(session);
  return (
    <LiveBlockView
      mark={<Icon aria-hidden className={cn("size-4", TONE_TEXT.amber)} />}
      title={
        <>
          <span className={cn("shrink-0 font-medium", TONE_TEXT.amber)}>
            {sentence}
            {text && ":"}
          </span>
          {text && (
            <SimpleTooltip whenTruncated tip={text}>
              <span className="min-w-0 truncate">{text}</span>
            </SimpleTooltip>
          )}
        </>
      }
      status={<RelativeDate date={new Date(session.at).toISOString()} />}
    />
  );
}

// A running script: its name, how long it has been up, and its output,
// restart and stop, or on a device that takes no commands from here,
// only a note saying so.
export function ScriptItemView({
  label,
  mono,
  since,
  readOnlyNote,
  onOutput,
  restart,
  stopping,
  onStop,
}: {
  label: string;
  // A package script's name is code.
  mono: boolean;
  since: number;
  readOnlyNote: string | null;
  onOutput: () => void;
  // A package script starts again the way its button starts it. The
  // lifecycle scripts belong to a create or a removal, so they only
  // stop.
  restart: { pending: boolean; onClick: () => void } | null;
  stopping: boolean;
  onStop: () => void;
}) {
  const busy = stopping || (restart?.pending ?? false);
  return (
    <LiveBlockView
      mark={<StatusDot tone="emerald" pulse />}
      title={
        <SimpleTooltip whenTruncated tip={label}>
          <span
            className={cn("min-w-0 truncate font-medium", mono && "font-mono")}
          >
            {label}
          </span>
        </SimpleTooltip>
      }
      status={<UptimeView since={since} />}
      // A device that takes no commands from here lets nothing be done
      // about its runs, its output included (attaching rides the same
      // grant), so the block only says so.
      detail={
        readOnlyNote === null ? undefined : (
          <SimpleTooltip tip={readOnlyNote}>
            <span>Read-only</span>
          </SimpleTooltip>
        )
      }
      actions={
        readOnlyNote === null && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className={ON_FILL}
              onClick={onOutput}
            >
              <SquareTerminal />
              Output
            </Button>
            {restart && (
              <Button
                size="sm"
                variant="ghost"
                className={ON_FILL}
                disabled={busy}
                onClick={restart.onClick}
              >
                <RotateCw className={cn(restart.pending && "animate-spin")} />
                {restart.pending ? "Restarting…" : "Restart"}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={busy}
              onClick={onStop}
            >
              {stopping ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Square className="size-3 fill-current" />
              )}
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          </>
        )
      }
    />
  );
}

// A mirror into this worktree from a peer, and since when.
export function MirrorStreamItemView({
  peer,
  since,
}: {
  // The device it comes from (DeviceNameView).
  peer: ReactNode;
  since: number;
}) {
  return (
    <LiveBlockView
      mark={
        <RefreshCw aria-hidden className={cn("size-4", TONE_TEXT.emerald)} />
      }
      title={
        <>
          <span className="shrink-0">Mirrored from</span>
          {peer}
        </>
      }
      status={<UptimeView since={since} />}
    />
  );
}

// A mirror from this worktree to a peer: how it is doing, and its
// manage dialog.
export function MirrorSessionItemView({
  peer,
  tone,
  spinning,
  label,
  detail,
  onManage,
  dialog,
}: {
  peer: ReactNode;
  tone: StatusTone;
  spinning: boolean;
  label: string;
  detail: string | undefined;
  // Unset while the device running it is out of reach.
  onManage: (() => void) | undefined;
  dialog: ReactNode;
}) {
  return (
    <>
      <LiveBlockView
        mark={
          <RefreshCw
            aria-hidden
            className={cn(
              "size-4",
              TONE_TEXT[tone],
              spinning && "animate-spin",
            )}
          />
        }
        title={
          <>
            <span className="shrink-0">Mirrored to</span>
            {peer}
          </>
        }
        status={<span className={TONE_TEXT[tone]}>{label}</span>}
        actions={
          <Button
            size="sm"
            variant="ghost"
            className={ON_FILL}
            disabled={onManage === undefined}
            onClick={onManage}
          >
            <Settings2 />
            Manage
          </Button>
        }
        detail={detail || undefined}
      />
      {dialog}
    </>
  );
}

// A forward of a peer's port: the local address it answers on, how
// busy it is, and its open, port change and stop.
export function ForwardItemView({
  localPort,
  remotePort,
  connCount,
  onOpen,
  onChangePort,
  stopping,
  onStop,
  dialog,
}: {
  localPort: number;
  remotePort: number;
  connCount: number;
  onOpen: () => void;
  // Through the Ports dialog of the worktree it was switched on from.
  onChangePort: (() => void) | null;
  stopping: boolean;
  onStop: () => void;
  dialog: ReactNode;
}) {
  return (
    <>
      <LiveBlockView
        mark={<Cable aria-hidden className="size-4 text-muted-foreground" />}
        title={
          <span className="min-w-0 truncate font-mono font-medium">
            localhost:{localPort}
          </span>
        }
        // The Ports dialog's own words for a forward in use.
        status={
          <SimpleTooltip
            tip={
              connCount > 0
                ? pluralize(connCount, "open connection")
                : "Nothing connected right now"
            }
          >
            <span className={cn("tabular", connCount > 0 && TONE_TEXT.emerald)}>
              {connCount > 0 ? `${connCount} open` : "idle"}
            </span>
          </SimpleTooltip>
        }
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              className={ON_FILL}
              onClick={onOpen}
            >
              <ExternalLinkIcon />
              Open
            </Button>
            {onChangePort && (
              <Button
                size="sm"
                variant="ghost"
                className={ON_FILL}
                onClick={onChangePort}
              >
                <Settings2 />
                Change port
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={stopping}
              onClick={onStop}
            >
              {stopping ? <Loader2 className="animate-spin" /> : <X />}
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          </>
        }
        // The port it reaches, when it is not the local one's number.
        // The card's device heading says on which device.
        detail={
          remotePort !== localPort ? (
            <span className="shrink-0">
              from <span className="font-mono">{remotePort}</span>
            </span>
          ) : undefined
        }
      />
      {dialog}
    </>
  );
}

// One live thing inside a card, as a block of two rows: what it is
// and how it stands (its mark, its name, the status at the end), then
// what can be done about it, as labelled buttons, with any further
// detail at the end of that row.
export function LiveBlockView({
  mark,
  title,
  status,
  actions,
  detail,
}: {
  mark: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2.5 text-sm">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {mark}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {title}
        </span>
        {status && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {status}
          </span>
        )}
      </div>
      {(actions || detail) && (
        // Under the title, so the buttons line up with the name above
        // them rather than with the mark. A phone has no room for the
        // indent: there the buttons share the row's width.
        <div className="-ml-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 pl-6.5 phone:ml-0 phone:pl-0">
          {actions && (
            <span className="flex items-center gap-1 phone:grid phone:w-full phone:auto-cols-fr phone:grid-flow-col">
              {actions}
            </span>
          )}
          {detail && (
            <span className="ml-auto flex min-w-0 items-center gap-1 truncate pl-2 text-xs text-muted-foreground phone:ml-0 phone:pl-0">
              {detail}
            </span>
          )}
        </div>
      )}
    </li>
  );
}
