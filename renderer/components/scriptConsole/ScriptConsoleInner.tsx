import { Play, Square } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { usePackageScripts } from "@/hooks/scripts/usePackageScripts";
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { assertNever } from "@/lib/utils";
import { scriptRuns, slotLabel, type ScriptSlot } from "@/store/scriptRuns";
import type { Worktree } from "@shared/schemas";
import { ConsoleBody } from "./ConsoleBody";
import { ScriptStatusBadge } from "@/components/shared/ScriptStatusBadge";

interface InnerProps {
  worktree: Worktree;
  slot: ScriptSlot;
  onBack: () => void;
}

export function ScriptConsoleInner({ worktree, slot, onBack }: InnerProps) {
  const { key, state, busy, start, stop } = useScriptRunner(worktree, slot);
  const { data: config } = useShigomoriConfig(worktree.projectId);
  const { data: pkg } = usePackageScripts(worktree.projectId, worktree.id);

  const command = resolveCommand(slot, config, pkg);
  const label = slotLabel(slot);

  const clear = () => scriptRuns.clear(key);
  const canClear = !busy && state.chunkTotal > 0;
  // Lifecycle scripts the CLI ran for the app stream here too, but
  // their process lives in the CLI, not behind one of our PTYs.
  const outputOnly = busy && !state.interactive;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 pt-7 pb-4">
        <BackButton onClick={onBack} label={worktree.branch} />
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="truncate font-mono text-xl font-medium tracking-tight">
              {label}
            </h1>
            {command && (
              <p className="truncate font-mono text-xs text-muted-foreground select-text">
                {command}
              </p>
            )}
            <div className="min-h-[1rem]">
              <ScriptStatusBadge state={state} variant="header" />
            </div>
            {outputOnly && (
              <p className="text-xs text-muted-foreground">
                Output only: this run was started by the CLI, so the console
                can't send it input.
              </p>
            )}
          </div>
          <div className="shrink-0">
            {busy ? (
              <Button
                variant="outline-destructive"
                size="sm"
                onClick={stop}
                disabled={state.cancelling}
              >
                <Square />
                {state.cancelling ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              <Button size="sm" onClick={start}>
                <Play />
                {state.status === "idle" ? "Run" : "Run again"}
              </Button>
            )}
          </div>
        </div>
      </header>

      <ConsoleBody
        runKey={key}
        state={state}
        onClear={canClear ? clear : null}
      />
    </div>
  );
}

function resolveCommand(
  slot: ScriptSlot,
  config:
    | { scripts?: { setup?: string; teardown?: string } }
    | null
    | undefined,
  pkg: { scripts: Record<string, string> } | null | undefined,
): string {
  switch (slot.kind) {
    case "setup":
      return config?.scripts?.setup ?? "";
    case "teardown":
      return config?.scripts?.teardown ?? "";
    case "portPool":
      return "";
    case "package":
      return pkg?.scripts[slot.name] ?? "";
    default:
      return assertNever(slot);
  }
}
