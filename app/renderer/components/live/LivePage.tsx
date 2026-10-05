// Everything running right now, across the account, on one page: the
// scripts each device runs, the ports this machine forwards from its
// peers, and the mirrors keeping worktrees in step between devices.
// The things a worktree page shows one worktree at a time, gathered so
// a dev server left running or a forgotten forward can be found (and
// stopped) without walking the forest. Every list is kept live by its
// own broadcast (hooks/live/useLiveActivity.ts).
import type React from "react";
import { PAGE_BODY } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  useLiveMirrors,
  useRunningScripts,
} from "@/hooks/live/useLiveActivity";
import {
  canForwardPorts,
  useAllPortForwards,
} from "@/hooks/remote/usePortForwards";
import { ForwardRow } from "./ForwardRow";
import { LiveList } from "./LiveRow";
import { MirrorRow } from "./MirrorRow";
import { ScriptRow } from "./ScriptRows";

export function LivePage() {
  const hosts = useRunningScripts();
  const mirrors = useLiveMirrors();
  // Which device a script or a mirror is on only says something once
  // there is more than one.
  const showDevice = hosts.length > 1;
  const scripts = hosts.flatMap(({ deviceId, api, runs }) =>
    api === undefined ? [] : runs.map((run) => ({ deviceId, api, run })),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Live" watermark="稼働" />
      <div className={PAGE_BODY}>
        <div className="flex max-w-3xl flex-col gap-8">
          <LiveSection
            title="Scripts"
            count={scripts.length}
            empty="No scripts running."
          >
            {scripts.map(({ deviceId, api, run }) => (
              <ScriptRow
                key={`${deviceId}:${run.runId}`}
                deviceId={deviceId}
                api={api}
                run={run}
                showDevice={showDevice}
              />
            ))}
          </LiveSection>
          {canForwardPorts && <ForwardSection />}
          <LiveSection
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
                showDevice={showDevice}
              />
            ))}
          </LiveSection>
        </div>
      </div>
    </div>
  );
}

function ForwardSection() {
  const { forwards, stop } = useAllPortForwards();
  return (
    <LiveSection
      title="Port forwards"
      count={forwards.length}
      empty="No ports forwarded."
    >
      {forwards.map((forward) => (
        <ForwardRow
          key={forward.forwardId}
          forward={forward}
          stopping={stop.isPending && stop.variables === forward.forwardId}
          onStop={() => stop.mutate(forward.forwardId)}
        />
      ))}
    </LiveSection>
  );
}

function LiveSection({
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
        <p className="text-xs text-muted-foreground/70">{empty}</p>
      )}
    </section>
  );
}
