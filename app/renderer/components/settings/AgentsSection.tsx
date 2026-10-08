import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionIntro } from "@/components/ui/section-heading";
import { StatusDot } from "@/components/ui/status-dot";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { gatedHostReadMeta } from "@/lib/queryClientOptions";
import type { AgentHarnessStatus } from "@shared/ipc/modules/agents";
import { tildify } from "@shared/projectPaths";

// The hooks each agent harness runs to report its sessions (`sm agents
// install`), which is what tells the app an agent is working in a
// worktree. Installed and removed right away, like the CLI's link:
// the hooks file is the harness's, not a setting of ours.
//
// Host-scoped: the hooks belong to whichever device the section is
// mounted for. A peer's is mounted only once it allows commands, since
// the statuses name its home.
export function AgentsSection() {
  const { api, keys, remote } = useHostScope();
  const queryClient = useQueryClient();
  const { data: harnesses } = useQuery<AgentHarnessStatus[]>({
    queryKey: keys.agents(),
    queryFn: () => api.agents.status(),
    meta: gatedHostReadMeta(remote, "Couldn't check the agent hooks"),
  });
  const applyStatus = (next: AgentHarnessStatus[]) => {
    queryClient.setQueryData(keys.agents(), next);
  };
  const setHooks = useMutation({
    mutationFn: (input: { harness: string; install: boolean }) =>
      api.agents.setHooks(input),
    onSuccess: applyStatus,
    meta: { errorTitle: "Couldn't change the hooks" },
  });
  if (!harnesses) return null;
  const busy = setHooks.isPending;

  return (
    <section className="space-y-3">
      <SectionIntro title="Coding agents">
        Hooks in each agent tell the app which worktree its session works in,
        and whether it is working or waiting on you.
      </SectionIntro>
      <div className="space-y-2">
        {harnesses.map((harness) => (
          <HarnessRow
            key={harness.id}
            harness={harness}
            busy={busy}
            onInstall={() =>
              setHooks.mutate({ harness: harness.id, install: true })
            }
            onUninstall={() =>
              setHooks.mutate({ harness: harness.id, install: false })
            }
          />
        ))}
      </div>
    </section>
  );
}

function HarnessRow({
  harness,
  busy,
  onInstall,
  onUninstall,
}: {
  harness: AgentHarnessStatus;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const untrusted = harness.hooks === "installed" && harness.trusted === false;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-24 text-sm">{harness.label}</span>
        {!harness.detected ? (
          <span className="text-xs text-muted-foreground">Not found</span>
        ) : (
          <>
            <StatusDot
              className="text-xs"
              tone={
                harness.hooks === "missing"
                  ? "slate"
                  : harness.hooks === "outdated" || untrusted
                    ? "amber"
                    : "emerald"
              }
              label={
                harness.hooks === "missing"
                  ? "Not installed"
                  : harness.hooks === "outdated"
                    ? "Installed by another version"
                    : untrusted
                      ? "Installed, not trusted yet"
                      : "Installed"
              }
            />
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground select-text">
              {tildify(harness.path, home)}
            </span>
            <span className="ml-auto flex gap-2">
              {harness.hooks !== "installed" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={onInstall}
                >
                  <Download />
                  {harness.hooks === "outdated" ? "Reinstall" : "Install"}
                </Button>
              )}
              {harness.hooks !== "missing" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={onUninstall}
                >
                  <Trash2 />
                  Remove
                </Button>
              )}
            </span>
          </>
        )}
      </div>
      {untrusted && (
        <p className="pl-27 text-xs text-muted-foreground">
          Codex runs a new hook only once you trust it: run{" "}
          <span className="font-mono">/hooks</span> in Codex and trust these.
        </p>
      )}
    </div>
  );
}
