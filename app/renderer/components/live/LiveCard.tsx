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
import { ForwardLine, MirrorLine, ScriptLine } from "./LiveItems";
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
  const worktree = useCardWorktree(card);
  // The worktree's page offers the console and the dialogs too, so a
  // card that cannot reach its device still leads there.
  return (
    <article className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      {card.worktree ? (
        <WorktreeHeader
          deviceId={card.deviceId}
          {...card.worktree}
          worktree={worktree}
        />
      ) : (
        <PortsHeader />
      )}
      <ul className="flex flex-col gap-1.5">
        {card.items.map((item) =>
          item.kind === "script" ? (
            <ScriptLine
              key={item.run.runId}
              deviceId={card.deviceId}
              api={item.api}
              run={item.run}
            />
          ) : item.kind === "mirror" ? (
            <MirrorLine
              key={
                item.mirror.kind === "session"
                  ? item.mirror.session.session
                  : item.mirror.stream.channelId
              }
              mirror={item.mirror}
            />
          ) : (
            <ForwardLine
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
function useCardWorktree(card: LiveCardModel): Worktree | undefined {
  const scope = useDeviceApi(card.deviceId);
  return useQuery({
    ...worktreesQueryOptions(card.worktree?.projectId ?? null, scope),
    select: (worktrees) =>
      worktrees.find((entry) => entry.id === card.worktree?.worktreeId),
  }).data;
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
}: {
  deviceId: string;
  projectId: string;
  worktreeId: string;
  worktree: Worktree | undefined;
}) {
  const scope = useDeviceApi(deviceId);
  const project = useQuery({
    ...projectsQueryOptions(scope),
    select: (projects) => projects.find((entry) => entry.id === projectId),
    meta: { silentError: true },
  }).data;
  const title = (
    <>
      <ProjectIcon
        projectId={projectId}
        name={project?.name ?? "?"}
        deviceId={deviceId}
        className="size-8"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-sm font-medium">
          {worktree ? (
            <BranchLabel
              branch={worktree.branch}
              detached={worktree.detached}
              suffixClassName="text-xs"
            />
          ) : (
            <span className="font-sans text-muted-foreground italic">
              Removed worktree
            </span>
          )}
        </span>
        <span className="truncate text-2xs text-muted-foreground">
          {[worktree?.name, project?.name].filter(Boolean).join(" · ")}
        </span>
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
          className="group/open -m-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1 transition-colors hover:bg-accent/60"
        >
          {title}
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover/open:text-foreground"
          />
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2.5">{title}</div>
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
          <LocalhostLink key={port.port} port={port.port} />
        ) : canForwardPorts ? (
          <PeerPort
            key={port.port}
            deviceId={deviceId}
            port={port.port}
            worktree={worktree}
          />
        ) : (
          // A browser cannot bind a port, so a peer's server is only
          // news here.
          <span key={port.port} className="font-mono">
            :{port.port}
          </span>
        ),
      )}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto rounded-sm transition-colors hover:text-foreground"
      >
        All ports
      </button>
      {open && (
        <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function LocalhostLink({ port }: { port: number }) {
  return (
    <SimpleTooltip tip={`Open localhost:${port}`}>
      <span className="inline-flex">
        <ExternalLink
          href={`http://localhost:${port}`}
          errorTitle="Couldn't open the port"
          className="inline-flex items-center gap-1 font-mono no-underline hover:text-foreground"
        >
          <PortDot />
          localhost:{port}
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
  worktree,
}: {
  deviceId: string;
  port: number;
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
        Forward <span className="font-mono">{port}</span>
      </ChipButton>
    </SimpleTooltip>
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

// One live thing inside a card: its mark, what it is, the fact beside
// it, and its actions at the end. A line that leads somewhere (a
// script's output, a mirror's dialog) is a control as a whole, with a
// chevron saying so.
export function LiveLine({
  mark,
  label,
  meta,
  actions,
  onOpen,
  openLabel,
}: {
  mark: React.ReactNode;
  label: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  onOpen?: () => void;
  // The open control's accessible name.
  openLabel?: string;
}) {
  const body = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {mark}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">{label}</span>
      {meta && (
        <span className="flex min-w-0 shrink items-center gap-1.5 truncate text-xs text-muted-foreground">
          {meta}
        </span>
      )}
    </>
  );
  return (
    <li className="flex min-h-10 items-center gap-1 rounded-md bg-muted/60 pr-1.5 text-sm">
      {onOpen ? (
        <button
          type="button"
          aria-label={openLabel}
          onClick={onOpen}
          className="group/line flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md pl-3 text-left transition-colors hover:bg-accent/70"
        >
          {body}
          <ChevronRight
            aria-hidden
            className="mr-1 ml-auto size-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover/line:text-foreground"
          />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-3">
          {body}
        </div>
      )}
      {actions && (
        <span className="flex shrink-0 items-center gap-0.5">{actions}</span>
      )}
    </li>
  );
}
