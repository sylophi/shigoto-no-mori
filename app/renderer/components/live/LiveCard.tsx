// The Live page's surfaces: a device's heading, and the card of one
// worktree's live things. A card is built like a project tile and is a
// way into the worktree as much as a report on it: its header opens the
// worktree's page, its launchers open it in an editor or a shell (on
// this machine), each live thing has its controls on its line
// (LiveItems.tsx), and its listening ports sit along the bottom with
// the worktree's own Ports dialog behind them. The card is scoped to
// the device holding the worktree, so the dialogs it opens drive that
// device exactly as the worktree's page would.
import type React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Cable, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { DeviceMark } from "@/components/shared/DeviceGlyph";
import { LauncherIcon } from "@/components/shared/LauncherIcon";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { BranchLabel } from "@/components/ui/branch-label";
import { Chip, ChipButton } from "@/components/ui/chip-button";
import { IconButton } from "@/components/ui/icon-button";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { PortsDialog } from "@/components/worktreeDetail/ports/PortsDialog";
import {
  useLaunch,
  useLauncherForProject,
} from "@/hooks/launchers/useLaunchers";
import { useWorktreePorts } from "@/hooks/ports/useWorktreePorts";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { useDeviceApi } from "@/hooks/remote/useDeviceApi";
import { HostScopeProvider, useHostScope } from "@/hooks/remote/useHostScope";
import {
  canForwardPorts,
  useAllPortForwards,
} from "@/hooks/remote/usePortForwards";
import {
  useDeviceIcon,
  useDeviceProperName,
  useRemoteDevice,
} from "@/hooks/remote/useRemoteDevices";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";
import { hasLocalHost } from "@/lib/localHost";
import { openExternalUrl } from "@/lib/openExternal";
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
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
      {card.worktree ? (
        <WorktreeHeader
          deviceId={card.deviceId}
          {...card.worktree}
          worktree={worktree}
          launchers={reachable && card.deviceId === localDeviceId}
        />
      ) : (
        <PortsHeader />
      )}
      <ul className="flex flex-col gap-1">
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
// folder and project under it, the whole of it the way to its page,
// and on this machine the first of its launch tools beside it. One the
// device no longer lists (removed while something still ran there)
// says so.
function WorktreeHeader({
  deviceId,
  projectId,
  worktreeId,
  worktree,
  launchers,
}: {
  deviceId: string;
  projectId: string;
  worktreeId: string;
  worktree: Worktree | undefined;
  launchers: boolean;
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
      {launchers && worktree && <Launchers worktree={worktree} />}
    </header>
  );
}

// The first few of the project's launch tools, as icons: the editor
// and the shell a running worktree is most often opened in.
const LAUNCHERS_SHOWN = 3;

function Launchers({ worktree }: { worktree: Worktree }) {
  const { data } = useLauncherForProject(worktree.projectId);
  const launch = useLaunch();
  const entries = (data?.entries ?? []).slice(0, LAUNCHERS_SHOWN);
  return (
    <span className="flex shrink-0 items-center">
      {entries.map((entry) => (
        <SimpleTooltip key={entry.id} tip={`Open in ${entry.label}`}>
          <IconButton
            aria-label={`Open in ${entry.label}`}
            disabled={launch.isPending}
            onClick={() =>
              launch.mutate({
                projectId: worktree.projectId,
                worktreeId: worktree.id,
                launcherId: entry.id,
              })
            }
          >
            {launch.isPending && launch.variables?.launcherId === entry.id ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LauncherIcon entry={entry} className="size-4" />
            )}
          </IconButton>
        </SimpleTooltip>
      ))}
    </span>
  );
}

// The worktree's ports that answer right now, along the card's foot:
// on this machine each opens in the browser, on a peer each not yet
// forwarded leads to the Ports dialog, where its forward is switched
// on. The dialog itself closes the row, for everything else a port
// can do (another local port, a port added by hand).
function PortsStrip({
  worktree,
  forwarded,
}: {
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
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {answering.map((port) =>
        remote && !canForwardPorts ? (
          // A browser cannot bind a port, so a peer's server is only
          // news here.
          <Chip key={port.port} className="text-muted-foreground">
            <PortDot />
            <span className="font-mono">{port.port}</span>
            {port.label && <span>{port.label}</span>}
          </Chip>
        ) : remote ? (
          <SimpleTooltip
            key={port.port}
            tip={`Forward ${port.port} to this machine`}
          >
            <ChipButton
              className="text-foreground"
              onClick={() => setOpen(true)}
            >
              <PortDot />
              <span className="font-mono">{port.port}</span>
              {port.label && <span>{port.label}</span>}
            </ChipButton>
          </SimpleTooltip>
        ) : (
          <SimpleTooltip key={port.port} tip={`Open localhost:${port.port}`}>
            <ChipButton
              className="text-foreground"
              onClick={() =>
                openExternalUrl(
                  `http://localhost:${port.port}`,
                  "Couldn't open the port",
                )
              }
            >
              <PortDot />
              <span className="font-mono">localhost:{port.port}</span>
              {port.label && <span>{port.label}</span>}
              <ExternalLink aria-hidden className="size-3 opacity-60" />
            </ChipButton>
          </SimpleTooltip>
        ),
      )}
      <ChipButton className="ml-auto" onClick={() => setOpen(true)}>
        <Cable aria-hidden className="size-3" />
        Ports
      </ChipButton>
      {open && (
        <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </div>
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

// One live thing inside a card: its mark, what it is (a control of its
// own when the line leads somewhere), the fact beside it, and its
// quiet actions at the end.
export function LiveLine({
  mark,
  label,
  meta,
  actions,
}: {
  mark: React.ReactNode;
  label: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <li className="flex min-h-8 items-center gap-2 rounded-md bg-muted/60 py-1 pr-1 pl-2 text-xs">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {mark}
      </span>
      <span className="flex min-w-0 items-center gap-1">{label}</span>
      {meta && (
        <span className="flex min-w-0 shrink items-center gap-1 truncate text-muted-foreground">
          {meta}
        </span>
      )}
      {actions && (
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {actions}
        </span>
      )}
    </li>
  );
}
