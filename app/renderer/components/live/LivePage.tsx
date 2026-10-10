// Everything running right now, across the account, on one page: the
// agents waiting on you, the scripts each device runs, the ports this
// machine forwards from its peers, and the mirrors keeping worktrees in
// step between devices.
// What a worktree page shows one worktree at a time, gathered so a dev
// server left running or a forgotten forward can be found (and
// stopped) without walking the forest. Each worktree with something
// live is a card (liveModel.ts), filed under its device. Every list is
// kept live by its own broadcast (hooks/live/useLiveActivity.ts).
import { useMutation } from "@tanstack/react-query";
import { Square } from "lucide-react";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";
import {
  type HostScripts,
  useLiveMirrors,
  useRunningScripts,
} from "@/hooks/live/useLiveActivity";
import { agentsNeedYou } from "@/lib/agentNeeds";
import { useWaitingAgents } from "@/lib/agentWatch";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { scriptRunsFor } from "@/store/scriptRuns";
import { useAllPortForwards } from "@/hooks/remote/usePortForwards";
import { pluralize } from "@/lib/pluralize";
import { notifyError, toast } from "@/lib/toast";
import { DeviceHeading, LiveCard } from "./LiveCard";
import { LiveDeviceSectionView, LivePageView } from "./LivePageView";
import { buildLive, countLive, type LiveDevice } from "./liveModel";

// "1 agent needs you, with 2 scripts, 1 port forward and 1 mirror
// running", leaving out what is none.
function summarize(devices: readonly LiveDevice[]): string {
  const { agents, scripts, forwards, mirrors } = countLive(devices);
  const parts = [
    scripts > 0 && pluralize(scripts, "script"),
    forwards > 0 && pluralize(forwards, "port forward"),
    mirrors > 0 && pluralize(mirrors, "mirror"),
  ].filter((part) => part !== false);
  const running =
    parts.length < 2
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const needYou = agents > 0 && agentsNeedYou(agents);
  if (needYou && running) return `${needYou}, with ${running} running`;
  if (needYou) return needYou;
  return running ? `${running} running` : "";
}

export function LivePage() {
  const hosts = useRunningScripts();
  const mirrors = useLiveMirrors();
  const forwards = useAllPortForwards();
  const agents = useWaitingAgents();
  const devices = buildLive({ agents, scripts: hosts, mirrors, forwards });
  // Which device a card is on only says something once there is more
  // than one.
  const multiDevice = hosts.length > 1;
  const summary = summarize(devices);
  // Until every reachable device has answered, an empty page would
  // claim a quiet it does not know.
  const loading = hosts.some((host) => host.loading);

  return (
    <LivePageView
      eyebrow={
        summary !== ""
          ? summary
          : loading
            ? "Asking your devices…"
            : "Nothing running"
      }
      trailing={<StopAllScripts hosts={hosts} />}
      state={devices.length > 0 ? "devices" : loading ? "loading" : "quiet"}
    >
      {devices.map((device) => (
        <LiveDeviceSectionView
          key={device.deviceId}
          heading={
            multiDevice && (
              <DeviceHeading
                deviceId={device.deviceId}
                summary={summarize([device])}
              />
            )
          }
        >
          {device.cards.map((card) => (
            <LiveCard key={card.key} card={card} />
          ))}
        </LiveDeviceSectionView>
      ))}
    </LivePageView>
  );
}

// Every running script this window may stop, on every device, in one
// go: the end of a day's work, or a machine bogged down by dev servers
// left behind. Armed by a first click, like the app's other removals.
function StopAllScripts({ hosts }: { hosts: readonly HostScripts[] }) {
  const registry = useRemoteDevices();
  const { armed, trigger } = useConfirmTwice();
  const runs = hosts.flatMap(({ deviceId, api, runs: hostRuns }) =>
    api !== undefined &&
    commandAccessOf(
      deviceId,
      registry.find((device) => device.deviceId === deviceId),
    ).canCommand
      ? hostRuns.map((run) => ({ deviceId, run }))
      : [],
  );
  const stopAll = useMutation({
    mutationFn: () =>
      Promise.allSettled(
        runs.map(({ deviceId, run }) => scriptRunsFor(deviceId).stopRun(run)),
      ),
    // The rows go as each script ends, so the outcome is said once,
    // here, rather than left to the page emptying.
    // A stop the host refused, or could not be asked for, is not one.
    onSuccess: (results) => {
      const stopped = results.filter(
        (r) => r.status === "fulfilled" && r.value,
      ).length;
      const failed = results.length - stopped;
      if (stopped > 0) toast.success(`Stopped ${pluralize(stopped, "script")}`);
      if (failed > 0) {
        notifyError(`Couldn't stop ${pluralize(failed, "script")}`);
      }
    },
  });
  if (runs.length === 0 && !stopAll.isPending) return null;
  const total = hosts.reduce((sum, host) => sum + host.runs.length, 0);
  // "all" only when it is: a read-only device's runs stay running.
  const readOnly = total - runs.length;
  return (
    <ConfirmDestructiveButton
      armed={armed}
      pending={stopAll.isPending}
      pendingLabel="Stopping…"
      idleLabel={stopAllLabel(runs.length, readOnly)}
      icon={<Square aria-hidden className="size-3 fill-current" />}
      tip={
        readOnly > 0
          ? `${pluralize(readOnly, "script")} on a read-only device ${readOnly === 1 ? "stays" : "stay"} running`
          : undefined
      }
      onClick={() => trigger(() => stopAll.mutate())}
    />
  );
}

function stopAllLabel(stoppable: number, readOnly: number): string {
  if (readOnly > 0) return `Stop ${pluralize(stoppable, "script")}`;
  if (stoppable === 1) return "Stop the script";
  return `Stop all ${stoppable} scripts`;
}
