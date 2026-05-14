import { useEffect, useRef, useState } from "react";
import { ChevronRight, Play, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { type LogLine, useScriptRun } from "@/hooks/useScriptRun";
import { usePackageScripts } from "@/hooks/usePackageScripts";
import type { Worktree } from "@shared/schemas";

interface PackageScriptsSectionProps {
  worktree: Worktree;
}

export function PackageScriptsSection({
  worktree,
}: PackageScriptsSectionProps) {
  const { data, isLoading } = usePackageScripts(
    worktree.projectId,
    worktree.id,
  );
  const [open, setOpen] = useState(false);
  const run = useScriptRun();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [run.logs]);

  if (isLoading) return null;
  if (!data) return null;
  const entries = Object.entries(data.scripts);
  if (entries.length === 0) return null;

  const hasOutput = run.logs.length > 0 || run.running;

  return (
    <>
      <Separator />
      <section className="space-y-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="group flex w-full items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase group-hover:text-foreground">
            Package scripts
          </h2>
          <span className="tabular text-[10px] font-medium text-muted-foreground/60">
            {entries.length}
          </span>
          <span className="ml-2 text-[10px] font-medium tracking-wide text-muted-foreground/50 uppercase">
            {data.packageManager}
          </span>
        </button>

        {open && (
          <div className="space-y-3 pl-4">
            <div className="flex flex-wrap items-center gap-1.5">
              {entries.map(([name, command]) => (
                <Button
                  key={name}
                  size="xs"
                  variant="ghost"
                  disabled={run.running}
                  onClick={() =>
                    run.start(
                      () =>
                        window.api.packageScripts.run({
                          projectId: worktree.projectId,
                          worktreeId: worktree.id,
                          scriptName: name,
                        }),
                      name,
                    )
                  }
                  title={command}
                >
                  <Play />
                  {name}
                </Button>
              ))}
              {run.running && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => run.cancel()}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Square />
                  Stop
                </Button>
              )}
              {hasOutput && !run.running && (
                <Button size="xs" variant="ghost" onClick={() => run.clear()}>
                  <Trash2 />
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
                className="max-h-64 overflow-y-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-xs leading-relaxed"
              >
                {run.logs.length === 0 ? (
                  <div className="text-muted-foreground">Starting…</div>
                ) : (
                  run.logs.map((log) => <LogChunk key={log.id} log={log} />)
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </>
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
