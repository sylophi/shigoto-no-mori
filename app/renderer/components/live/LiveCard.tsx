// The Live page's surfaces bound to their devices (LiveCardView.tsx
// draws them). The card is scoped to the device holding the worktree,
// so its runner and the dialogs it opens drive that device as the
// worktree's page would.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Worktree } from "@shigomori/contracts/schemas";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { PortsDialog } from "@/components/worktreeDetail/ports/PortsDialog";
import { useWorktreePorts } from "@/hooks/ports/useWorktreePorts";
import { projectPullRequestsQueryOptions } from "@/hooks/projects/useProjectPullRequests";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useDeviceApi } from "@/hooks/remote/useDeviceApi";
import { HostScopeProvider, useHostScope } from "@/hooks/remote/useHostScope";
import {
  canForwardPorts,
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
import {
  deviceStatusView,
  THIS_DEVICE_VIEW,
} from "@shigomori/ui/lib/deviceStatus.ts";
import { WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import {
  mappedPullRequest,
  worktreeTitle,
} from "@shigomori/ui/lib/worktreeTitle.ts";
import { ForwardItem, MirrorItem, ScriptItem } from "./LiveItems";
import { AgentItemView } from "@shigomori/ui/views/live/LiveItemsView.tsx";
import {
  DeviceHeadingView,
  LiveCardView,
  LivePortsHeaderView,
  LiveWorktreeHeaderView,
  LocalhostPortView,
  PeerPortView,
  PortReadoutView,
  PortsStripView,
} from "@shigomori/ui/views/live/LiveCardView.tsx";
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
    <DeviceHeadingView
      icon={icon}
      tone={status.tone}
      name={name}
      status={status.label}
      summary={summary}
    />
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
  const cardWorktree = useCardWorktree(card);
  const { worktree } = cardWorktree;
  // The peer's ports this machine forwards already have a block of
  // their own, so the strip leaves them out.
  const forwarded = card.items.flatMap((item) =>
    item.kind === "forward" ? [item.forward.remotePort] : [],
  );
  // Ports are polled while on screen, so only where they belong to a
  // script running here: a card for a mirror or a forward alone has no
  // dev server of its own to point at.
  const scripts = card.items.some((item) => item.kind === "script");
  // The worktree's page offers the console and the dialogs too, so a
  // card that cannot reach its device still leads there.
  return (
    <LiveCardView
      header={
        card.worktree ? (
          <WorktreeHeader
            deviceId={card.deviceId}
            {...card.worktree}
            state={cardWorktree}
          />
        ) : (
          <LivePortsHeaderView />
        )
      }
      ports={
        worktree &&
        reachable &&
        scripts && (
          <PortsStrip
            deviceId={card.deviceId}
            worktree={worktree}
            forwarded={forwarded}
          />
        )
      }
    >
      {card.items.map((item) =>
        item.kind === "agent" ? (
          <AgentItemView
            key={`${item.session.harness}:${item.session.session}`}
            session={item.session}
          />
        ) : item.kind === "script" ? (
          <ScriptItem
            key={item.run.runId}
            deviceId={card.deviceId}
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
            // Its Ports dialog reads the peer, so only under its scope.
            worktree={reachable ? worktree : undefined}
          />
        ),
      )}
    </LiveCardView>
  );
}

// Where the card's worktree stands: found in its device's list, the
// list still loading, the list in without it (removed while something
// ran there), or no list to be had (the device out of reach, with
// nothing cached from this window's session).
type CardWorktree =
  | { kind: "found"; worktree: Worktree }
  | { kind: "loading" | "missing" | "unreachable"; worktree: undefined };

function useCardWorktree(card: LiveCardModel): CardWorktree {
  const scope = useDeviceApi(card.deviceId);
  const query = useQuery({
    ...worktreesQueryOptions(card.worktree?.projectId ?? null, scope),
    select: (worktrees) =>
      worktrees.find((entry) => entry.id === card.worktree?.worktreeId),
  });
  if (query.data) return { kind: "found", worktree: query.data };
  if (query.isSuccess) return { kind: "missing", worktree: undefined };
  return {
    kind: scope.api === undefined ? "unreachable" : "loading",
    worktree: undefined,
  };
}

// The worktree a card is for: its project's icon, its title (else its
// branch) and its folder and project under it, the whole of it the way to its page.
// One the device no longer lists (removed while something still ran
// there) says so.
function WorktreeHeader({
  deviceId,
  projectId,
  worktreeId,
  state,
}: {
  deviceId: string;
  projectId: string;
  worktreeId: string;
  state: CardWorktree;
}) {
  const { worktree } = state;
  const deviceName = useDeviceProperName(deviceId);
  const scope = useDeviceApi(deviceId);
  const project = useQuery({
    ...projectsQueryOptions(scope),
    select: (projects) => projects.find((entry) => entry.id === projectId),
    meta: { silentError: true },
  }).data;
  // What the work is called, as its sidebar row names it: its PR's
  // title, the one `sm describe` gave it, else the branch.
  const prs = useQuery({
    ...projectPullRequestsQueryOptions(projectId, scope),
    meta: { silentError: true },
  }).data;
  const workTitle = worktree
    ? worktreeTitle(worktree, mappedPullRequest(prs, worktree))
    : null;
  // Held as placeholders until the lists are in, rather than read as
  // a worktree that is gone.
  const pending = state.kind === "loading";
  const unreachable = state.kind === "unreachable";
  return (
    <LiveWorktreeHeaderView
      icon={
        project ? (
          <ProjectIcon
            projectId={projectId}
            name={project.name}
            deviceId={deviceId}
            className="size-8"
          />
        ) : unreachable ? (
          "unreachable"
        ) : (
          "pending"
        )
      }
      heading={
        worktree
          ? {
              title: workTitle,
              branch: worktree.branch,
              detached: worktree.detached,
            }
          : pending
            ? "pending"
            : {
                note: unreachable
                  ? `A worktree on ${deviceName}`
                  : "Removed worktree",
              }
      }
      subline={
        pending
          ? null
          : unreachable
            ? `${deviceName} is out of reach`
            : [worktree?.name, project?.name].filter(Boolean).join(" in ")
      }
      renderLink={
        worktree
          ? (props) => (
              <Link
                to={WORKTREE_ROUTE_PATHS.detail}
                params={{ deviceId, projectId, worktreeId }}
                {...props}
              />
            )
          : null
      }
    />
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
  // A forward rides the peer's grant, and a browser binds no port.
  const { canCommand } = useCommandAccess();
  const canForward = canForwardPorts && canCommand;
  const [open, setOpen] = useState(false);
  const ports = useWorktreePorts(worktree).data?.ports ?? [];
  const answering = ports.filter(
    (port) => port.listening && !forwarded.includes(port.port),
  );
  if (answering.length === 0) return null;
  return (
    <PortsStripView
      onAllPorts={() => setOpen(true)}
      dialog={
        open && (
          <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
        )
      }
    >
      {answering.map((port) =>
        !remote ? (
          <LocalhostPortView
            key={port.port}
            port={port.port}
            label={port.label}
          />
        ) : canForward ? (
          <PeerPort
            key={port.port}
            deviceId={deviceId}
            port={port.port}
            label={port.label}
            worktree={worktree}
          />
        ) : (
          <PortReadoutView
            key={port.port}
            port={port.port}
            label={port.label}
          />
        ),
      )}
    </PortsStripView>
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
    <PeerPortView
      port={port}
      label={label}
      pending={control.isPending}
      error={control.error}
      onForward={() => control.apply({ on: true, localPort: port })}
    />
  );
}
