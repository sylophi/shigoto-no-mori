// Everything running right now, across the account, on one page: the
// scripts each device runs, the ports this machine forwards from its
// peers, and the mirrors keeping worktrees in step between devices.
// What a worktree's page shows one worktree at a time, gathered so a
// dev server left running or a forgotten forward can be found and
// dealt with without walking the forest. Laid out like the Tidy page:
// the counts on top, a list per kind (LiveRows.tsx), and a footer with
// the one action across all of them. Every list is kept live by its
// own broadcast (hooks/live/useLiveActivity.ts).
import type React from "react";
import { useMutation } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import type { RunningScript } from "@shared/schemas";
import { PAGE_BODY } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import { TidyStat } from "@/components/tidy/TidyStat";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  type LiveMirror,
  useLiveMirrors,
  useRunningScripts,
} from "@/hooks/live/useLiveActivity";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import type { HostApi } from "@/hooks/remote/useHostScope";
import {
  canForwardPorts,
  useAllPortForwards,
} from "@/hooks/remote/usePortForwards";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import { pluralize } from "@/lib/pluralize";
import { scriptKey, scriptRunsFor } from "@/store/scriptRuns";
import { ForwardRow, LiveList, MirrorRow, ScriptRow } from "./LiveRows";

type Script = { deviceId: string; api: HostApi; run: RunningScript };

export function LivePage() {
  const hosts = useRunningScripts();
  const mirrors = useLiveMirrors();
  const { forwards, stop } = useAllPortForwards();
  // Which device a row is on only says something once there is more
  // than one.
  const multiDevice = hosts.length > 1;
  const scripts: Script[] = hosts.flatMap(({ deviceId, api, runs }) =>
    api === undefined ? [] : runs.map((run) => ({ deviceId, api, run })),
  );
  const nothing =
    scripts.length === 0 && forwards.length === 0 && mirrors.length === 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Live" watermark="稼働" />
      <div className={PAGE_BODY}>
        {nothing ? (
          <Quiet />
        ) : (
          <div className="flex flex-col gap-6">
            <Stats
              scripts={scripts}
              devices={hosts.filter((host) => host.runs.length > 0).length}
              forwards={forwards}
              mirrors={mirrors}
            />
            <Section
              title="Scripts"
              count={scripts.length}
              empty="No scripts running."
            >
              {scripts.map(({ deviceId, api, run }, index) => (
                <ScriptRow
                  key={`${deviceId}:${run.runId}`}
                  deviceId={deviceId}
                  api={api}
                  run={run}
                  showDevice={multiDevice}
                  showPorts={
                    scripts.findIndex(
                      (other) =>
                        other.deviceId === deviceId &&
                        other.run.worktreeId === run.worktreeId,
                    ) === index
                  }
                />
              ))}
            </Section>
            {canForwardPorts && (
              <Section
                title="Port forwards"
                count={forwards.length}
                empty="No ports forwarded."
              >
                {forwards.map((forward) => (
                  <ForwardRow
                    key={forward.forwardId}
                    forward={forward}
                    stopping={
                      stop.isPending && stop.variables === forward.forwardId
                    }
                    onStop={() => stop.mutate(forward.forwardId)}
                  />
                ))}
              </Section>
            )}
            <Section
              title="Mirrors"
              count={mirrors.length}
              empty="No worktrees mirrored."
            >
              {mirrors.map((mirror) => (
                <MirrorRow
                  key={
                    mirror.kind === "session"
                      ? `${mirror.runnerDeviceId}:${mirror.session.session}`
                      : `${mirror.copyDeviceId}:${mirror.stream.channelId}`
                  }
                  mirror={mirror}
                  showDevice={multiDevice}
                />
              ))}
            </Section>
            <Footer scripts={scripts} />
          </div>
        )}
      </div>
    </div>
  );
}

// The counts on top, as the Tidy page opens with its own: how much of
// each is running and the one fact that says most about it.
function Stats({
  scripts,
  devices,
  forwards,
  mirrors,
}: {
  scripts: readonly Script[];
  devices: number;
  forwards: readonly { connCount: number }[];
  mirrors: readonly LiveMirror[];
}) {
  const conns = forwards.reduce((sum, forward) => sum + forward.connCount, 0);
  const troubled = mirrors.filter(
    (mirror) =>
      mirror.kind === "session" &&
      describeMirror(mirror.session, { engine: mirror.engine }).tone !==
        "emerald",
  ).length;
  return (
    <div
      className={
        canForwardPorts
          ? "grid grid-cols-3 gap-3 phone:gap-2"
          : "grid grid-cols-2 gap-3 phone:gap-2"
      }
    >
      <TidyStat
        label="Scripts"
        value={String(scripts.length)}
        detail={
          scripts.length === 0
            ? "none running"
            : devices > 1
              ? `on ${devices} devices`
              : "running"
        }
        tone={scripts.length > 0 ? "positive" : "neutral"}
      />
      {canForwardPorts && (
        <TidyStat
          label="Port forwards"
          value={String(forwards.length)}
          detail={
            forwards.length === 0
              ? "none open"
              : conns > 0
                ? `${pluralize(conns, "connection")} open`
                : "no connections"
          }
        />
      )}
      <TidyStat
        label="Mirrors"
        value={String(mirrors.length)}
        detail={
          mirrors.length === 0
            ? "none running"
            : troubled > 0
              ? `${troubled} need${troubled === 1 ? "s" : ""} a look`
              : "all in step"
        }
      />
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>
        {title}
        {count > 0 && (
          <span className="tabular ml-1.5 font-normal text-muted-foreground/70">
            {count}
          </span>
        )}
      </SectionHeading>
      {count > 0 ? (
        <LiveList label={title}>{children}</LiveList>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

// What the page covers, and the one action across it: every running
// script this window may stop, on every device, at once (the end of a
// day, or a machine bogged down by dev servers left behind). Armed by
// a first click, like the app's other removals.
function Footer({ scripts }: { scripts: readonly Script[] }) {
  const registry = useRemoteDevices();
  const { armed, trigger } = useConfirmTwice();
  const stoppable = scripts.filter(
    ({ deviceId }) =>
      commandAccessOf(
        deviceId,
        registry.find((device) => device.deviceId === deviceId),
      ).canCommand,
  );
  const stopAll = useMutation({
    mutationFn: () =>
      Promise.allSettled(
        stoppable.map(({ deviceId, api, run }) => {
          const store = scriptRunsFor(deviceId);
          const key = scriptKey(run.projectId, run.worktreeId, run.slot);
          return store.snapshot(key).runId === run.runId
            ? store.cancel(key)
            : api.scripts.cancel(run.runId);
        }),
      ),
  });
  return (
    <div className="flex items-center justify-between gap-3 phone:flex-wrap">
      <p className="text-xs text-muted-foreground">
        Scripts started on any of your devices show here, and their output opens
        from any of them.
      </p>
      {(stoppable.length > 0 || stopAll.isPending) && (
        <Button
          variant="destructive"
          size="sm"
          aria-pressed={armed}
          disabled={stopAll.isPending}
          onClick={() => trigger(() => stopAll.mutate())}
        >
          {stopAll.isPending
            ? "Stopping…"
            : armed
              ? "Click again to confirm"
              : stoppable.length === 1
                ? "Stop the script"
                : `Stop all ${stoppable.length} scripts`}
        </Button>
      )}
    </div>
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
