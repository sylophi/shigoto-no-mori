// The Live page's surfaces: a device's heading, and the card of one
// worktree's live things. A card is built like a project tile and is a
// way into the worktree as much as a report on it: its header opens the
// worktree's page, each live thing has its controls on its line
// (LiveItems.tsx), and the ports that answer sit along the bottom. The card is scoped to
// the device holding the worktree, so the dialogs it opens drive that
// device exactly as the worktree's page would.
import type React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Cable,
  ChevronRight,
  ExternalLink as ExternalLinkIcon,
  Loader2,
  Plus,
} from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { DeviceMark } from "@/components/shared/DeviceGlyph";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { BranchLabel } from "@/components/ui/branch-label";
import { Skeleton } from "@/components/ui/skeleton";
import { ChipButton } from "@/components/ui/chip-button";
import { ExternalLink } from "@/components/ui/external-link";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { PortsDialog } from "@/components/worktreeDetail/ports/PortsDialog";
import { useWorktreePorts } from "@/hooks/ports/useWorktreePorts";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { useDeviceApi } from "@/hooks/remote/useDeviceApi";
import { HostScopeProvider, useHostScope } from "@/hooks/remote/useHostScope";
import {
  canForwardPorts,
  useAllPortForwards,
  usePortForwardControl,
} from "@/hooks/remote/usePortForwards";
import {
  useDeviceIcon,
  useDeviceProperName,
  useRemoteDevice,
} from "@/hooks/remote/useRemoteDevices";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";
import { deviceStatusView, THIS_DEVICE_VIEW } from "@/lib/remote/deviceStatus";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { cn } from "@/lib/utils";
import { ForwardItem, MirrorItem, ScriptItem } from "./LiveItems";
import type { LiveCard as LiveCardModel } from "./liveModel";

// A device's heading over its cards: its mark in its connection tone,
// its name, where it stands, and how much runs there.
export function DeviceHeading({
  deviceId,
  summary,
}: {
  deviceId: string;
  summary: string;
}) {
  const icon = useDeviceIcon(deviceId);
  const name = useDeviceProperName(deviceId);
  const device = useRemoteDevice(deviceId);
  const status = device ? deviceStatusView(device.status) : THIS_DEVICE_VIEW;
  return (
    <div className="flex items-center gap-2">
      <DeviceMark icon={icon} tone={status.tone} />
      <h2 className="truncate text-sm font-medium">{name}</h2>
      <span className={cn("shrink-0 text-xs", TONE_TEXT[status.tone])}>
        {status.label}
      </span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
        {summary}
      </span>
    </div>
  );
}

// The card under its device's scope, while that device can be reached.
// A peer out of reach keeps its card (its mirror and forwards are still
// there), with nothing on it that would need the peer.
export function LiveCard({ card }: { card: LiveCardModel }) {
  const { api } = useDeviceApi(card.deviceId);
  const local = card.deviceId === localDeviceId;
  const reachable = local ? hasLocalHost : api !== undefined;
  const body = <CardBody card={card} reachable={reachable} />;
  if (local || api === undefined) return body;
  return (
    <HostScopeProvider deviceId={card.deviceId} api={api}>
      {body}
    </HostScopeProvider>
  );
}

function CardBody({
  card,
  reachable,
}: {
  card: LiveCardModel;
  reachable: boolean;
}) {
  const { forwards, stop } = useAllPortForwards();
  const { worktree, listed } = useCardWorktree(card);
  // The worktree's page offers the console and the dialogs too, so a
  // card that cannot reach its device still leads there.
  return (
    <article className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      {card.worktree ? (
        <WorktreeHeader
          deviceId={card.deviceId}
          {...card.worktree}
          worktree={worktree}
          listed={listed}
        />
      ) : (
        <PortsHeader />
      )}
      <ul className="flex flex-col gap-2">
        {card.items.map((item) =>
          item.kind === "script" ? (
            <ScriptItem
              key={item.run.runId}
              deviceId={card.deviceId}
              api={item.api}
              run={item.run}
            />
          ) : item.kind === "mirror" ? (
            <MirrorItem
              key={
                item.mirror.kind === "session"
                  ? item.mirror.session.session
                  : item.mirror.stream.channelId
              }
              mirror={item.mirror}
            />
          ) : (
            <ForwardItem
              key={item.forward.forwardId}
              forward={item.forward}
              worktree={worktree}
              showDevice={card.worktree === null}
              stopping={
                stop.isPending && stop.variables === item.forward.forwardId
              }
              onStop={() => stop.mutate(item.forward.forwardId)}
            />
          ),
        )}
      </ul>
      {worktree && reachable && (
        <PortsStrip
          deviceId={card.deviceId}
          worktree={worktree}
          forwarded={forwards
            .filter(
              (forward) =>
                forward.deviceId === card.deviceId &&
                forward.worktree?.worktreeId === worktree.id,
            )
            .map((forward) => forward.remotePort)}
        />
      )}
    </article>
  );
}

// The card's worktree off the same cached list the sidebar keeps.
// `listed` is whether the list is in, so a worktree not found in it
// reads as removed only once there is a list to have missed it.
function useCardWorktree(card: LiveCardModel): {
  worktree: Worktree | undefined;
  listed: boolean;
} {
  const scope = useDeviceApi(card.deviceId);
  const query = useQuery({
    ...worktreesQueryOptions(card.worktree?.projectId ?? null, scope),
    select: (worktrees) =>
      worktrees.find((entry) => entry.id === card.worktree?.worktreeId),
  });
  return { worktree: query.data, listed: query.isSuccess };
}

// The worktree a card is for: its project's icon, its branch and its
// folder and project under it, the whole of it the way to its page.
// One the device no longer lists (removed while something still ran
// there) says so.
function WorktreeHeader({
  deviceId,
  projectId,
  worktreeId,
  worktree,
  listed,
}: {
  deviceId: string;
  projectId: string;
  worktreeId: string;
  worktree: Worktree | undefined;
  listed: boolean;
}) {
  const scope = useDeviceApi(deviceId);
  const project = useQuery({
    ...projectsQueryOptions(scope),
    select: (projects) => projects.find((entry) => entry.id === projectId),
    meta: { silentError: true },
  }).data;
  // Held as placeholders until the lists are in, rather than read as
  // a worktree that is gone.
  const pending = worktree === undefined && !listed;
  const title = (
    <>
      {project ? (
        <ProjectIcon
          projectId={projectId}
          name={project.name}
          deviceId={deviceId}
          className="size-8"
        />
      ) : (
        <Skeleton className="size-8 shrink-0 rounded-md" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {worktree ? (
          <SimpleTooltip whenTruncated tip={worktree.branch}>
            <span className="truncate font-mono text-sm font-medium">
              <BranchLabel
                branch={worktree.branch}
                detached={worktree.detached}
                suffixClassName="text-xs"
              />
            </span>
          </SimpleTooltip>
        ) : pending ? (
          <Skeleton className="h-4 w-36" />
        ) : (
          <span className="truncate text-sm text-muted-foreground italic">
            Removed worktree
          </span>
        )}
        {pending ? (
          <Skeleton className="h-3 w-24" />
        ) : (
          <span className="truncate text-2xs text-muted-foreground">
            {[worktree?.name, project?.name].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
    </>
  );
  return (
    <header className="flex min-w-0 items-center gap-1">
      {worktree ? (
        <Link
          to={WORKTREE_ROUTE_PATHS.detail}
          params={{ deviceId, projectId, worktreeId }}
          aria-label={`Open ${worktree.branch}`}
          className="group/open -m-1.5 flex min-w-0 flex-1 items-center gap-3 rounded-md p-1.5 transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {title}
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover/open:text-foreground"
          />
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{title}</div>
      )}
    </header>
  );
}

// The worktree's ports that answer right now, along the card's foot,
// once there are any: on this machine a link to each, on a peer a
// one-click forward to the same local port (the line above takes it
// over once on). "All ports" opens the worktree's Ports dialog, for
// everything else a port can do.
function PortsStrip({
  deviceId,
  worktree,
  forwarded,
}: {
  deviceId: string;
  worktree: Worktree;
  // The peer's ports this machine forwards already, which have a line
  // of their own above.
  forwarded: readonly number[];
}) {
  const { remote } = useHostScope();
  const [open, setOpen] = useState(false);
  const ports = useWorktreePorts(worktree).data?.ports ?? [];
  const answering = ports.filter(
    (port) => port.listening && !forwarded.includes(port.port),
  );
  if (answering.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
      {answering.map((port) =>
        !remote ? (
          <LocalhostLink key={port.port} port={port.port} label={port.label} />
        ) : canForwardPorts ? (
          <PeerPort
            key={port.port}
            deviceId={deviceId}
            port={port.port}
            label={port.label}
            worktree={worktree}
          />
        ) : (
          // A browser cannot bind a port, so a peer's server is only
          // news here.
          <span key={port.port} className="inline-flex items-center gap-1">
            <PortDot />
            <PortText port={port.port} label={port.label} />
          </span>
        ),
      )}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto rounded-sm transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        All ports
      </button>
      {open && (
        <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function LocalhostLink({ port, label }: { port: number; label?: string }) {
  return (
    <SimpleTooltip tip={`Open localhost:${port}`}>
      <span className="inline-flex">
        <ExternalLink
          href={`http://localhost:${port}`}
          errorTitle="Couldn't open the port"
          className="inline-flex items-center gap-1 rounded-sm no-underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PortDot />
          <PortText port={`localhost:${port}`} label={label} />
          <ExternalLinkIcon aria-hidden className="size-3" />
        </ExternalLink>
      </span>
    </SimpleTooltip>
  );
}

// A peer's port not forwarded yet: one click reaches it at the same
// local port here.
function PeerPort({
  deviceId,
  port,
  label,
  worktree,
}: {
  deviceId: string;
  port: number;
  label?: string;
  worktree: Worktree;
}) {
  const control = usePortForwardControl(deviceId, port, {
    projectId: worktree.projectId,
    worktreeId: worktree.id,
  });
  return (
    <SimpleTooltip tip={control.error ?? `Reach ${port} at localhost here`}>
      <ChipButton
        disabled={control.isPending}
        onClick={() => control.apply({ on: true, localPort: port })}
        className={cn("py-0.5", control.error && "text-destructive")}
      >
        {control.isPending ? (
          <Loader2 aria-hidden className="size-3 animate-spin" />
        ) : (
          <Plus aria-hidden className="size-3" />
        )}
        <PortText prefix="Forward" port={port} label={label} />
      </ChipButton>
    </SimpleTooltip>
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

function PortDot() {
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 rounded-full bg-emerald-500"
    />
  );
}

// A device's loose forwards, the ones switched on from the account
// page rather than a worktree.
function PortsHeader() {
  return (
    <header className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Cable aria-hidden className="size-4" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">Forwarded ports</span>
        <span className="truncate text-2xs text-muted-foreground">
          Not tied to a worktree
        </span>
      </div>
    </header>
  );
}

// One live thing inside a card, as a block of two rows: what it is
// and how it stands (its mark, its name, the status at the end), then
// what can be done about it, as labelled buttons, with any further
// detail at the end of that row.
export function LiveItem({
  mark,
  title,
  status,
  actions,
  detail,
}: {
  mark: React.ReactNode;
  title: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
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
