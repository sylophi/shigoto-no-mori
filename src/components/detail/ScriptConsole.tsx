import { useEffect, useRef } from "react";
import { ArrowLeft, Play, Square, Trash2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { usePackageScripts } from "@/hooks/usePackageScripts";
import { useScriptRunner } from "@/hooks/useScriptRunner";
import { useShigomoriConfig } from "@/hooks/useShigomoriConfig";
import { useWorktrees } from "@/hooks/useWorktrees";
import {
  paramToSlot,
  scriptRuns,
  slotLabel,
  type LogLine,
  type ScriptRunState,
  type ScriptSlot,
} from "@/store/scriptRuns";
import { scriptConsoleRoute } from "@/router";
import type { Worktree } from "@shared/schemas";
import { ScriptStatusBadge } from "./ScriptStatusBadge";

export function ScriptConsole() {
  const { projectId, worktreeName, scriptKey: rawKey } =
    scriptConsoleRoute.useParams();
  const navigate = useNavigate();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.name === worktreeName);
  const slot = paramToSlot(rawKey);

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeName",
      params: { projectId, worktreeName },
    });

  if (!worktree || !slot) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-border px-6 pt-7 pb-4">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft aria-hidden className="size-3" />
            <span>Back</span>
          </button>
        </header>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Script not found.
        </div>
      </div>
    );
  }

  return (
    <ScriptConsoleInner worktree={worktree} slot={slot} onBack={goBack} />
  );
}

interface InnerProps {
  worktree: Worktree;
  slot: ScriptSlot;
  onBack: () => void;
}

function ScriptConsoleInner({ worktree, slot, onBack }: InnerProps) {
  const { key, state, busy, start, stop } = useScriptRunner(worktree, slot);
  const { data: config } = useShigomoriConfig(worktree.projectId);
  const { data: pkg } = usePackageScripts(worktree.projectId, worktree.id);

  const command = resolveCommand(slot, config, pkg);
  const label = slotLabel(slot);

  const clear = () => scriptRuns.clear(key);

  const canClear = !busy && state.logs.length > 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 pt-7 pb-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-3" />
          <span>{worktree.branch}</span>
        </button>
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
          </div>
          <div className="shrink-0">
            {busy ? (
              <Button
                variant="outline"
                size="sm"
                onClick={stop}
                disabled={state.cancelling}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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

      <ConsoleBody state={state} onClear={canClear ? clear : null} />
    </div>
  );
}

function ConsoleBody({
  state,
  onClear,
}: {
  state: ScriptRunState;
  onClear: (() => void) | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Honor the user's scroll position: if they scroll up to read history,
  // don't yank them back down on every new line.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distanceFromBottom < 24;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [state.logs]);

  if (state.status === "idle" && state.logs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        No runs yet. Press Run to start.
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto bg-background px-6 py-4 font-mono text-xs leading-relaxed select-text"
      >
        {state.logs.length === 0 ? (
          <div className="text-muted-foreground">Starting…</div>
        ) : (
          state.logs.map((log) => <LogChunk key={log.id} log={log} />)
        )}
      </div>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear log"
          title="Clear log"
          className="absolute top-2 right-3 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function LogChunk({ log }: { log: LogLine }) {
  const cls =
    log.stream === "stderr" || log.stream === "error"
      ? "text-destructive whitespace-pre-wrap"
      : log.stream === "exit"
        ? "text-muted-foreground whitespace-pre-wrap"
        : "whitespace-pre-wrap";
  return <span className={cls}>{log.text}</span>;
}

function resolveCommand(
  slot: ScriptSlot,
  config: { scripts?: { setup?: string; teardown?: string } } | null | undefined,
  pkg: { scripts: Record<string, string> } | null | undefined,
): string {
  if (slot.kind === "setup") return config?.scripts?.setup ?? "";
  if (slot.kind === "teardown") return config?.scripts?.teardown ?? "";
  return pkg?.scripts[slot.name] ?? "";
}
