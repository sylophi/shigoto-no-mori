import { Download, Trash2 } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { SectionIntro } from "@shigomori/ui/primitives/section-heading.tsx";
import { StatusDot } from "@shigomori/ui/primitives/status-dot.tsx";
import type { AgentHarnessStatus } from "@shigomori/contracts/schemas";
import { tildify } from "@shigomori/contracts/projectPaths";

// The hooks each agent harness runs to report its sessions (`sm agents
// install`), which is what tells the app an agent is working in a
// worktree. Installed and removed right away, like the CLI's link:
// the hooks file is the harness's, not a setting of ours.
//
// Host-scoped: the hooks belong to whichever device the section is
// mounted for. A peer's is mounted only once it allows commands, since
// the statuses name its home.
export function AgentsSectionView({
  harnesses,
  home,
  busy,
  onSetHooks,
}: {
  harnesses: readonly AgentHarnessStatus[];
  // The device's home, for the hooks' paths.
  home: string | null;
  busy: boolean;
  onSetHooks: (harness: string, install: boolean) => void;
}) {
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
            home={home}
            onInstall={() => onSetHooks(harness.id, true)}
            onUninstall={() => onSetHooks(harness.id, false)}
          />
        ))}
      </div>
    </section>
  );
}

function HarnessRow({
  harness,
  busy,
  home,
  onInstall,
  onUninstall,
}: {
  harness: AgentHarnessStatus;
  busy: boolean;
  home: string | null;
  onInstall: () => void;
  onUninstall: () => void;
}) {
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
