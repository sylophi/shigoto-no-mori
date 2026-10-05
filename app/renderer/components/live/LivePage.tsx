// Everything running right now, across the account, on one page: the
// scripts each device runs, the ports this machine forwards from its
// peers, and the mirrors keeping worktrees in step between devices.
// What a worktree page shows one worktree at a time, gathered so a dev
// server left running or a forgotten forward can be found (and
// stopped) without walking the forest. Each worktree with something
// live is a card (liveModel.ts), filed under its device. Every list is
// kept live by its own broadcast (hooks/live/useLiveActivity.ts).
import { Radio } from "lucide-react";
import { PAGE_BODY } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import {
  useLiveMirrors,
  useRunningScripts,
} from "@/hooks/live/useLiveActivity";
import { useAllPortForwards } from "@/hooks/remote/usePortForwards";
import { pluralize } from "@/lib/pluralize";
import { DeviceHeading, LiveCard } from "./LiveCard";
import { ForwardLine, MirrorLine, ScriptLine } from "./LiveItems";
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
  const { forwards, stop } = useAllPortForwards();
  const devices = buildLive({ scripts: hosts, mirrors, forwards });
  // Which device a card is on only says something once there is more
  // than one.
  const multiDevice = hosts.length > 1;
  const summary = summarize(devices);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow={summary === "" ? "Nothing running" : `${summary} running`}
        title="Live"
        watermark="稼働"
      />
      <div className={PAGE_BODY}>
        {devices.length === 0 ? (
          <Quiet />
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
                <div className="grid grid-cols-[repeat(auto-fill,minmax(--spacing(72),1fr))] items-start gap-3">
                  {device.cards.map((card) => (
                    <LiveCard key={card.key} card={card}>
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
                            showDevice={card.worktree === null}
                            stopping={
                              stop.isPending &&
                              stop.variables === item.forward.forwardId
                            }
                            onStop={() => stop.mutate(item.forward.forwardId)}
                          />
                        ),
                      )}
                    </LiveCard>
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
