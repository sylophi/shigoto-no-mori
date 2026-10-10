// The live things a card lists, bound to what they run on. An agent
// waiting on you is drawn as it is (AgentItemView). A script: its
// output (the console takes up the run's output whichever window or
// device started it, hooks/scripts/useScriptRunner.ts), a restart and a
// stop. A mirror: how it is doing, and its manage dialog (status,
// history, pause, the ignore rule, stop) under the device running it,
// as the worktree's Mirror button opens it. A forward: the local
// address it answers on, the worktree's Ports dialog to move it to
// another local port, and its stop, which never needs the peer.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { PortForwardSummary } from "@shigomori/contracts/modules/portForward";
import type { RunningScript, Worktree } from "@shigomori/contracts/schemas";
import { RunnerScope } from "@/components/worktreeDetail/mirror/MirrorAction";
import { MirrorManageDialog } from "@/components/worktreeDetail/mirror/MirrorManageDialog";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import { useMirrorView } from "@/components/worktreeDetail/mirror/useMirrorView";
import { PortsDialog } from "@/components/worktreeDetail/ports/PortsDialog";
import type { LiveMirror } from "@/hooks/live/useLiveActivity";
import { usePortForwardStop } from "@/hooks/remote/usePortForwards";
import {
  useDeviceIcon,
  useDeviceProperName,
} from "@/hooks/remote/useRemoteDevices";
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { openExternalUrl } from "@/lib/openExternal";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { slotLabel } from "@/store/scriptRuns";
import {
  DeviceNameView,
  ForwardItemView,
  MirrorSessionItemView,
  MirrorStreamItemView,
  ScriptItemView,
} from "@shigomori/ui/views/live/LiveItemsView.tsx";

// A device inline, by its id.
function DeviceName({ deviceId }: { deviceId: string }) {
  const icon = useDeviceIcon(deviceId);
  const name = useDeviceProperName(deviceId);
  return <DeviceNameView icon={icon} name={name} />;
}

// Under the card's scope (LiveCard), so the runner reads and drives
// the run on the device it runs on, as a worktree's script row does.
export function ScriptItem({
  deviceId,
  run,
}: {
  deviceId: string;
  run: RunningScript;
}) {
  const { toScriptOn } = useWorktreeNav();
  const { state, canRun, start, stop } = useScriptRunner(
    { projectId: run.projectId, id: run.worktreeId },
    run.slot,
  );
  const deviceName = useDeviceProperName(deviceId);
  // Starts again only once the run is stopped: a start beside a run
  // that would not stop is a second dev server on the same port.
  const restart = useMutation({
    mutationFn: async () => {
      if (!(await stop())) throw new Error("The running script didn't stop.");
      await start();
    },
    meta: { errorTitle: "Couldn't restart the script" },
  });
  return (
    <ScriptItemView
      label={slotLabel(run.slot)}
      mono={run.slot.kind === "package"}
      since={run.startedAt}
      readOnlyNote={canRun ? null : peerReadOnlyNote(deviceName)}
      onOutput={() =>
        toScriptOn(deviceId, run.projectId, run.worktreeId, run.slot)
      }
      restart={
        run.slot.kind === "package"
          ? { pending: restart.isPending, onClick: () => restart.mutate() }
          : null
      }
      stopping={state.cancelling}
      onStop={() => void stop()}
    />
  );
}

export function MirrorItem({ mirror }: { mirror: LiveMirror }) {
  return mirror.kind === "session" ? (
    <SessionItem mirror={mirror} />
  ) : (
    <MirrorStreamItemView
      peer={<DeviceName deviceId={mirror.stream.peerDeviceId} />}
      since={mirror.stream.since}
    />
  );
}

function SessionItem({
  mirror,
}: {
  mirror: Extract<LiveMirror, { kind: "session" }>;
}) {
  const { session, runnerDeviceId, runnerApi, engine } = mirror;
  const [open, setOpen] = useState(false);
  // The runner going away takes the dialog with it.
  if (open && runnerApi === undefined) setOpen(false);
  const managed = useMirrorView(
    {
      runnerDeviceId,
      runnerApi,
      otherDeviceId: session.deviceId,
      otherCopy: {
        projectId: session.projectId,
        worktreeId: session.worktreeId,
      },
      session,
      engine,
    },
    session,
  );
  const view = describeMirror(session, {
    runnerAway: runnerApi === undefined ? managed.names.runner : undefined,
    engine,
  });
  return (
    <MirrorSessionItemView
      peer={<DeviceName deviceId={session.deviceId} />}
      tone={view.tone}
      spinning={view.spinning}
      label={view.label}
      detail={view.detail}
      onManage={runnerApi === undefined ? undefined : () => setOpen(true)}
      dialog={
        open &&
        runnerApi !== undefined && (
          <RunnerScope deviceId={runnerDeviceId} api={runnerApi}>
            <MirrorManageDialog
              session={session}
              {...managed}
              onClose={() => setOpen(false)}
              onStopped={() => setOpen(false)}
            />
          </RunnerScope>
        )
      }
    />
  );
}

export function ForwardItem({
  forward,
  worktree,
}: {
  forward: PortForwardSummary;
  // The worktree it was switched on from, whose Ports dialog moves it.
  worktree: Worktree | undefined;
}) {
  const [open, setOpen] = useState(false);
  const stop = usePortForwardStop();
  return (
    <ForwardItemView
      localPort={forward.localPort}
      remotePort={forward.remotePort}
      connCount={forward.connCount}
      onOpen={() =>
        openExternalUrl(
          `http://localhost:${forward.localPort}`,
          "Couldn't open the port",
        )
      }
      onChangePort={worktree ? () => setOpen(true) : null}
      stopping={stop.isPending}
      onStop={() => stop.mutate(forward.forwardId)}
      dialog={
        open &&
        worktree && (
          <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
        )
      }
    />
  );
}
