// The Live page over the fixtures: what runs on this Mac and the
// Thinkpad, an agent waiting, the scripts, a mirror each way and a
// forwarded port, and the page with nothing running.
import type { ReactNode } from "react";
import {
  DeviceHeadingView,
  LiveCardView,
  LivePortsHeaderView,
  LiveWorktreeHeaderView,
  LocalhostPortView,
  PeerPortView,
  PortReadoutView,
  PortsStripView,
} from "../views/live/LiveCardView.tsx";
import {
  AgentItemView,
  DeviceNameView,
  ForwardItemView,
  MirrorSessionItemView,
  MirrorStreamItemView,
  ScriptItemView,
} from "../views/live/LiveItemsView.tsx";
import {
  LiveDeviceSectionView,
  LivePageView,
} from "../views/live/LivePageView.tsx";
import { ProjectIconView } from "../views/shared/ProjectIconView.tsx";
import { peerReadOnlyNote } from "../lib/commandAccessCopy.ts";
import type { Worktree } from "@shigomori/contracts/schemas/index";
import {
  fakeRunningScripts,
  LOCAL_DEVICE_ID,
  THINKPAD_ID,
} from "../fixtures/fixtures.ts";
import { SceneWindowFrame } from "./frame.tsx";
import { SceneSidebar } from "./sidebar.tsx";
import { deviceById, projectNamed, worktreeNamed } from "./world.ts";

const noop = () => {};
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");
const QUAIL = worktreeNamed(SM, "quiet-quail");
const BADGER = worktreeNamed(SM, "brave-badger");
const HUM = worktreeNamed(SM, "happy-hummingbird");
const MAC = deviceById(LOCAL_DEVICE_ID);
const THINKPAD = deviceById(THINKPAD_ID);
const runOf = (worktreeId: string) =>
  fakeRunningScripts[LOCAL_DEVICE_ID]?.find((r) => r.worktreeId === worktreeId);

function header(worktree: Worktree, title: string | null) {
  return (
    <LiveWorktreeHeaderView
      icon={<ProjectIconView src={null} name={SM.name} className="size-8" />}
      heading={{ title, branch: worktree.branch, detached: false }}
      subline={`${worktree.name} in ${SM.name}`}
      renderLink={({ children, ...props }) => (
        <a href="#open" {...props}>
          {children}
        </a>
      )}
    />
  );
}

function deviceHeading(device: typeof MAC, summary: string) {
  return (
    <DeviceHeadingView
      icon={device.icon}
      tone={device.status.tone}
      name={device.label}
      status={device.status.label}
      summary={summary}
    />
  );
}

function script(worktreeId: string, readOnlyNote: string | null = null) {
  const run = runOf(worktreeId);
  if (!run) return null;
  return (
    <ScriptItemView
      label={run.slot.kind === "package" ? run.slot.name : "Setup"}
      mono={run.slot.kind === "package"}
      since={run.startedAt}
      readOnlyNote={readOnlyNote}
      onOutput={noop}
      restart={{ pending: false, onClick: noop }}
      stopping={false}
      onStop={noop}
    />
  );
}

function livePage(
  state: "quiet" | "devices",
  children: ReactNode,
  eyebrow: string,
) {
  return (
    <SceneWindowFrame
      sidebar={<SceneSidebar view="projects" open />}
      pathname="/live"
    >
      <LivePageView eyebrow={eyebrow} trailing={null} state={state}>
        {children}
      </LivePageView>
    </SceneWindowFrame>
  );
}

// Two devices' live things.
export function LivePageScene() {
  const waiting = QUAIL.agentSessions?.find((s) => s.state === "waiting");
  return livePage(
    "devices",
    <>
      <LiveDeviceSectionView
        heading={deviceHeading(
          MAC,
          "1 agent needs you, with 2 scripts running",
        )}
      >
        <LiveCardView
          header={header(QUAIL, "Retry the pool lease before giving up")}
          ports={null}
        >
          {waiting && <AgentItemView session={waiting} />}
        </LiveCardView>
        <LiveCardView
          header={header(BADGER, null)}
          ports={
            <PortsStripView onAllPorts={noop} dialog={null}>
              <LocalhostPortView port={5173} label="vite" />
              <LocalhostPortView port={6006} />
            </PortsStripView>
          }
        >
          {script(BADGER.id)}
        </LiveCardView>
        <LiveCardView
          header={header(HUM, "Aggregate worktrees across devices")}
          ports={null}
        >
          {script(HUM.id)}
          <MirrorSessionItemView
            peer={<DeviceNameView icon={THINKPAD.icon} name={THINKPAD.label} />}
            tone="emerald"
            spinning={false}
            label="In step"
            detail={undefined}
            onManage={noop}
            dialog={null}
          />
        </LiveCardView>
      </LiveDeviceSectionView>
      <LiveDeviceSectionView
        heading={deviceHeading(THINKPAD, "1 script and 1 port forward running")}
      >
        <LiveCardView
          header={header(HUM, null)}
          ports={
            <PortsStripView onAllPorts={noop} dialog={null}>
              <PeerPortView
                port={5174}
                label="vite"
                pending={false}
                error={undefined}
                onForward={noop}
              />
              <PortReadoutView port={8787} label="worker" />
            </PortsStripView>
          }
        >
          <ScriptItemView
            label="dev"
            mono
            since={Date.now() - 3 * 3_600_000}
            readOnlyNote={peerReadOnlyNote(THINKPAD.label)}
            onOutput={noop}
            restart={null}
            stopping={false}
            onStop={noop}
          />
          <MirrorStreamItemView
            peer={<DeviceNameView icon={MAC.icon} name={MAC.label} />}
            since={Date.now() - 40 * 60_000}
          />
        </LiveCardView>
        <LiveCardView header={<LivePortsHeaderView />} ports={null}>
          <ForwardItemView
            localPort={5432}
            remotePort={5433}
            connCount={2}
            onOpen={noop}
            onChangePort={null}
            stopping={false}
            onStop={noop}
            dialog={null}
          />
        </LiveCardView>
      </LiveDeviceSectionView>
    </>,
    "1 agent needs you, with 3 scripts, 1 port forward and 2 mirrors running",
  );
}

// Nothing running anywhere.
export function LiveQuietScene() {
  return livePage("quiet", null, "Nothing running");
}
