import type { ReactNode } from "react";
import {
  Cable,
  ChevronRight,
  ExternalLink as ExternalLinkIcon,
  FolderGit2,
  Loader2,
  Plus,
} from "lucide-react";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { DeviceMarkView } from "@/components/shared/DeviceGlyphView";
import { BranchLabel } from "@shigomori/ui/primitives/branch-label.tsx";
import { ChipButton } from "@shigomori/ui/primitives/chip-button.tsx";
import { ExternalLink } from "@shigomori/ui/primitives/external-link.tsx";
import { Skeleton } from "@shigomori/ui/primitives/skeleton.tsx";
import {
  StatusDot,
  TONE_TEXT,
  type StatusTone,
} from "@shigomori/ui/primitives/status-dot.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";

// The Live page's surfaces (LiveCard.tsx binds them): a device's
// heading, and the card of one worktree's live things. A card is built
// like a project tile and is a way into the worktree as much as a
// report on it: its header opens the worktree's page, each live thing
// has its controls in its block (LiveItemsView.tsx), and the ports that
// answer sit along the bottom.

// A device's heading over its cards: its mark in its connection tone,
// its name, where it stands, and how much runs there.
export function DeviceHeadingView({
  icon,
  tone,
  name,
  status,
  summary,
}: {
  icon: DeviceIcon;
  tone: StatusTone;
  name: string;
  status: string;
  summary: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <DeviceMarkView icon={icon} tone={tone} />
      <SimpleTooltip whenTruncated tip={name}>
        <h2 className="truncate text-sm font-medium">{name}</h2>
      </SimpleTooltip>
      <span className={cn("shrink-0 text-xs", TONE_TEXT[tone])}>{status}</span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
        {summary}
      </span>
    </div>
  );
}

// One worktree's card: its header, its live things, and its ports.
export function LiveCardView({
  header,
  ports,
  children,
}: {
  header: ReactNode;
  // The ports strip, for a card with a script running here.
  ports: ReactNode;
  // The live things, each a block (LiveItemsView.tsx).
  children: ReactNode;
}) {
  return (
    <article
      data-slot="live-card"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
    >
      {header}
      <ul className="flex flex-col gap-2">{children}</ul>
      {ports}
    </article>
  );
}

// The props a header's way into its worktree carries, for the
// container's router link to take.
export interface WorktreeLinkProps {
  "aria-label": string;
  className: string;
  children: ReactNode;
}

// The worktree a card is for: its project's icon, its title (else its
// branch) and its folder and project under it, the whole of it the way
// to its page. One the device no longer lists (removed while something
// still ran there) says so, and one on a device out of reach says that.
export function LiveWorktreeHeaderView({
  icon,
  heading,
  subline,
  renderLink,
}: {
  // The project's icon, or what stands in for it.
  icon: ReactNode | "unreachable" | "pending";
  // What the work is called, or a note in its place.
  heading:
    | { title: string | null; branch: string; detached: boolean }
    | { note: string }
    | "pending";
  // Its folder and project, or null while they are loading.
  subline: string | null;
  // The way to the worktree's page, once it is found.
  renderLink: ((props: WorktreeLinkProps) => ReactNode) | null;
}) {
  const title = (
    <>
      {icon === "unreachable" ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FolderGit2 aria-hidden className="size-4" />
        </span>
      ) : icon === "pending" ? (
        <Skeleton className="size-8 shrink-0 rounded-md" />
      ) : (
        icon
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {heading === "pending" ? (
          <Skeleton className="h-4 w-36" />
        ) : "note" in heading ? (
          <span className="truncate text-sm text-muted-foreground italic">
            {heading.note}
          </span>
        ) : (
          <SimpleTooltip whenTruncated tip={heading.title ?? heading.branch}>
            <span
              className={cn(
                "truncate text-sm font-medium",
                heading.title === null && "font-mono",
              )}
            >
              {heading.title ?? (
                <BranchLabel
                  branch={heading.branch}
                  detached={heading.detached}
                  suffixClassName="text-xs"
                />
              )}
            </span>
          </SimpleTooltip>
        )}
        {subline === null ? (
          <Skeleton className="h-3 w-24" />
        ) : (
          <span className="truncate text-2xs text-muted-foreground">
            {subline}
          </span>
        )}
      </span>
    </>
  );
  const label =
    heading !== "pending" && !("note" in heading)
      ? (heading.title ?? heading.branch)
      : "";
  return (
    <div className="flex min-w-0 items-center gap-1">
      {renderLink ? (
        renderLink({
          "aria-label": `Open ${label}`,
          className:
            "group/open -m-1.5 flex min-w-0 flex-1 items-center gap-3 rounded-md p-1.5 transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
          children: (
            <>
              {title}
              <ChevronRight
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover/open:text-foreground"
              />
            </>
          ),
        })
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{title}</div>
      )}
    </div>
  );
}

// A device's loose forwards, the ones switched on from the account
// page rather than a worktree.
export function LivePortsHeaderView() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Cable aria-hidden className="size-4" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">Forwarded ports</span>
        <span className="truncate text-2xs text-muted-foreground">
          Not tied to a worktree
        </span>
      </div>
    </div>
  );
}

// The worktree's ports that answer right now, along the card's foot:
// on this machine a link to each, on a peer a one-click forward to the
// same local port (the line above takes it over once on). "All ports"
// opens the worktree's Ports dialog, for everything else a port can do.
export function PortsStripView({
  onAllPorts,
  dialog,
  children,
}: {
  onAllPorts: () => void;
  dialog: ReactNode;
  // The ports, each a LocalhostPortView, PeerPortView or PortReadoutView.
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
      {children}
      <button
        type="button"
        onClick={onAllPorts}
        className="ml-auto rounded-sm transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        All ports
      </button>
      {dialog}
    </div>
  );
}

export function LocalhostPortView({
  port,
  label,
}: {
  port: number;
  label?: string;
}) {
  return (
    <span className="inline-flex">
      <ExternalLink
        href={`http://localhost:${port}`}
        errorTitle="Couldn't open the port"
        className="inline-flex items-center gap-1 rounded-sm no-underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ListeningDot />
        <PortText port={`localhost:${port}`} label={label} />
        <ExternalLinkIcon aria-hidden className="size-3" />
      </ExternalLink>
    </span>
  );
}

// A peer's port not forwarded yet: one click reaches it at the same
// local port here.
export function PeerPortView({
  port,
  label,
  pending,
  error,
  onForward,
}: {
  port: number;
  label?: string;
  pending: boolean;
  error: string | null | undefined;
  onForward: () => void;
}) {
  return (
    <SimpleTooltip tip={error}>
      <ChipButton
        disabled={pending}
        onClick={onForward}
        className={cn("py-0.5", error && "text-destructive")}
      >
        {pending ? (
          <Loader2 aria-hidden className="size-3 animate-spin" />
        ) : (
          <Plus aria-hidden className="size-3" />
        )}
        <PortText prefix="Forward" port={port} label={label} />
      </ChipButton>
    </SimpleTooltip>
  );
}

// A peer's server this window cannot forward is only news.
export function PortReadoutView({
  port,
  label,
}: {
  port: number;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <ListeningDot />
      <PortText port={port} label={label} />
    </span>
  );
}

// A port's words as one run of text, so the mono number and the sans
// words around it share a baseline. As separate flex items each would
// be centered on its own box, and the mono font's different metrics
// set the number off the words beside it.
function PortText({
  prefix,
  port,
  label,
}: {
  prefix?: string;
  port: number | string;
  label?: string;
}) {
  return (
    <span className="truncate">
      {prefix && <>{prefix} </>}
      <span className="font-mono">{port}</span>
      {label && <span className="text-muted-foreground"> {label}</span>}
    </span>
  );
}

// A port's dot: a server answers on it.
function ListeningDot() {
  return (
    <SimpleTooltip tip="A server is listening">
      <StatusDot tone="emerald" />
    </SimpleTooltip>
  );
}
