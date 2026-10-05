// Everything running right now, across the account, on one page: the
// scripts each device runs, the ports this machine forwards from its
// peers, and the mirrors keeping worktrees in step between devices.
// What a worktree page shows one worktree at a time, gathered so a dev
// server left running or a forgotten forward can be found (and
// stopped) without walking the forest. Each worktree with something
// live is a card (liveModel.ts), filed under its device. Every list is
// kept live by its own broadcast (hooks/live/useLiveActivity.ts).
import { useMutation } from "@tanstack/react-query";
import { Loader2, Radio, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PAGE_BODY } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import {
  type HostScripts,
  useLiveMirrors,
  useRunningScripts,
} from "@/hooks/live/useLiveActivity";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { scriptKey, scriptRunsFor } from "@/store/scriptRuns";
import { useAllPortForwards } from "@/hooks/remote/usePortForwards";
import { pluralize } from "@/lib/pluralize";
import { notifyError, toast } from "@/lib/toast";
import { DeviceHeading, LiveCard } from "./LiveCard";
import { buildLive, countLive, type LiveDevice } from "./liveModel";

// "2 scripts, 1 port forward and 1 mirror", leaving out what is none.
function summarize(devices: readonly LiveDevice[]): string {
  const { scripts, forwards, mirrors } = countLive(devices);
  const parts = [
    scripts > 0 && pluralize(scripts, "script"),
    forwards > 0 && pluralize(forwards, "port forward"),
    mirrors > 0 && pluralize(mirrors, "mirror"),
  ].filter((part) => part !== false);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function LivePage() {
  const hosts = useRunningScripts();
  const mirrors = useLiveMirrors();
  const { forwards } = useAllPortForwards();
  const devices = buildLive({ scripts: hosts, mirrors, forwards });
  // Which device a card is on only says something once there is more
  // than one.
  const multiDevice = hosts.length > 1;
  const summary = summarize(devices);
  // Until every reachable device has answered, an empty page would
  // claim a quiet it does not know.
  const loading = hosts.some((host) => host.loading);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow={
          summary !== ""
            ? `${summary} running`
            : loading
              ? "Asking your devices…"
              : "Nothing running"
        }
        title="Live"
        watermark="稼働"
        trailing={<StopAllScripts hosts={hosts} />}
      />
      <div className={PAGE_BODY}>
        {devices.length === 0 ? (
          loading ? null : (
            <Quiet />
          )
        ) : (
          <div className="flex flex-col gap-8">
            {devices.map((device) => (
              <section
                key={device.deviceId}
                aria-label={multiDevice ? undefined : "Live"}
                className="flex flex-col gap-3"
              >
                {multiDevice && (
                  <DeviceHeading
                    deviceId={device.deviceId}
                    summary={summarize([device])}
                  />
                )}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,--spacing(88)),1fr))] items-start gap-4">
                  {device.cards.map((card) => (
                    <LiveCard key={card.key} card={card} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
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
      ? hostRuns.map((run) => ({ deviceId, api, run }))
      : [],
  );
  const stopAll = useMutation({
    mutationFn: () =>
      Promise.allSettled(
        runs.map(({ deviceId, api, run }) => {
          const store = scriptRunsFor(deviceId);
          const key = scriptKey(run.projectId, run.worktreeId, run.slot);
          return store.snapshot(key).runId === run.runId
            ? store.cancel(key)
            : api.scripts.cancel(run.runId);
        }),
      ),
    // The rows go as each script ends, so the outcome is said once,
    // here, rather than left to the page emptying.
    onSuccess: (results) => {
      const failed = results.filter((r) => r.status === "rejected").length;
      const stopped = results.length - failed;
      if (stopped > 0) toast.success(`Stopped ${pluralize(stopped, "script")}`);
      if (failed > 0) {
        notifyError(`Couldn't stop ${pluralize(failed, "script")}`);
      }
    },
  });
  if (runs.length === 0 && !stopAll.isPending) return null;
  return (
    <Button
      size="sm"
      variant="outline-destructive"
      aria-pressed={armed}
      disabled={stopAll.isPending}
      onClick={() => trigger(() => stopAll.mutate())}
    >
      {stopAll.isPending ? (
        <Loader2 className="animate-spin" />
      ) : (
        <Square className="size-3 fill-current" />
      )}
      {stopAll.isPending
        ? "Stopping…"
        : armed
          ? "Click again to confirm"
          : `Stop ${runs.length === 1 ? "the script" : `all ${runs.length} scripts`}`}
    </Button>
  );
}

// Nothing live anywhere: say what would show here.
function Quiet() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Radio aria-hidden className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">All quiet in the forest</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Dev servers and other scripts, forwarded ports and mirrors show up
          here while they run, on any of your devices.
        </p>
      </div>
    </div>
  );
}
