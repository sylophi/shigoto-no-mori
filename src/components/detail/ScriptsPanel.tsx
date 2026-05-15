import { useEffect, useRef } from "react";
import { Play, Square, Trash2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useShigomoriConfig } from "@/hooks/useShigomoriConfig";
import { type LogLine, useScriptRun } from "@/hooks/useScriptRun";
import { cn } from "@/lib/utils";
import type { ScriptName, Worktree } from "@shared/schemas";

interface ScriptsPanelProps {
  worktree: Worktree;
}

const SCRIPT_LABELS: Record<ScriptName, string> = {
  setup: "Setup",
  teardown: "Teardown",
};

const SCRIPT_ORDER: ScriptName[] = ["setup", "teardown"];

export function ScriptsPanel({ worktree }: ScriptsPanelProps) {
  const { data: config, isLoading } = useShigomoriConfig(worktree.projectId);
  const run = useScriptRun();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the console to the bottom on new log lines.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [run.logs]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2" aria-label="Reading config">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-24" />
      </div>
    );
  }

  const scripts = config?.scripts ?? {};
  const defined = SCRIPT_ORDER.filter((name) => Boolean(scripts[name]));

  if (defined.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          No setup or teardown scripts configured.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void navigate({
              to: "/projects/$projectId/configure",
              params: { projectId: worktree.projectId },
            })
          }
        >
          Configure scripts
        </Button>
      </div>
    );
  }

  const hasOutput = run.logs.length > 0 || run.running;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {defined.map((name) => (
          <Button
            key={name}
            size="sm"
            variant="ghost"
            onClick={() =>
              run.start(
                () =>
                  window.api.scripts.run({
                    projectId: worktree.projectId,
                    worktreeId: worktree.id,
                    script: name,
                  }),
                SCRIPT_LABELS[name],
              )
            }
            disabled={run.running}
          >
            <Play className="size-3.5" />
            {SCRIPT_LABELS[name]}
          </Button>
        ))}
        {run.running && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => run.cancel()}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Square className="size-3.5" />
            Stop
          </Button>
        )}
        {hasOutput && !run.running && (
          <Button size="sm" variant="ghost" onClick={() => run.clear()}>
            <Trash2 className="size-3.5" />
            Clear
          </Button>
        )}
        {run.exitCode !== null && !run.running && (
          <span
            className={cn(
              "tabular ml-auto rounded-md border px-1.5 py-0.5 text-xs",
              run.exitCode === 0
                ? "border-border bg-card text-muted-foreground"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            exit {run.exitCode}
          </span>
        )}
      </div>

      {hasOutput && (
        <div
          ref={scrollRef}
          className="max-h-64 overflow-y-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-xs leading-relaxed select-text"
        >
          {run.logs.length === 0 ? (
            <div className="text-muted-foreground">Starting…</div>
          ) : (
            run.logs.map((log) => <LogChunk key={log.id} log={log} />)
          )}
        </div>
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
