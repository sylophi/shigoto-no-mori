import type { ReactNode, Ref } from "react";
import { Play, Square, Trash2 } from "lucide-react";
import { ScriptStatusBadgeView } from "@/components/shared/ScriptStatusBadgeView";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { IconButton } from "@/components/ui/icon-button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { ScriptRunState } from "@/store/scriptRuns";

// A script's console page (ScriptConsoleInner.tsx runs it): the script
// and its command, how its run stands, its run and stop, and the
// terminal under them.
export function ScriptConsolePageView({
  back,
  label,
  command,
  state,
  outputOnly,
  run,
  hiddenNote,
  children,
}: {
  back: { label: string; onClick: () => void };
  label: string;
  command: string;
  state: ScriptRunState;
  // The run was started by the CLI, so the console can't send it input.
  outputOnly: boolean;
  // A peer that takes no commands from here neither runs nor stops
  // scripts, nor shows their output: null there.
  run: { busy: boolean; onStart: () => void; onStop: () => void } | null;
  // What stands in for the output on such a peer.
  hiddenNote: string | null;
  // The console's body (ConsoleBodyView).
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 pt-7 pb-4">
        <BackButton onClick={back.onClick} label={back.label} />
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1 space-y-1">
            <SimpleTooltip whenTruncated tip={label}>
              <h1 className="truncate font-mono text-xl font-medium tracking-tight">
                {label}
              </h1>
            </SimpleTooltip>
            {command && (
              <SimpleTooltip whenTruncated tip={command}>
                <p className="truncate font-mono text-xs text-muted-foreground select-text">
                  {command}
                </p>
              </SimpleTooltip>
            )}
            <div className="min-h-[1rem]">
              <ScriptStatusBadgeView state={state} variant="header" />
            </div>
            {outputOnly && (
              <p className="text-xs text-muted-foreground">
                Output only: this run was started by the CLI, so the console
                can't send it input.
              </p>
            )}
          </div>
          {run && (
            <div className="shrink-0">
              {run.busy ? (
                <Button
                  variant="outline-destructive"
                  size="sm"
                  onClick={run.onStop}
                  disabled={state.cancelling}
                >
                  <Square />
                  {state.cancelling ? "Stopping…" : "Stop"}
                </Button>
              ) : (
                <Button size="sm" onClick={run.onStart}>
                  <Play />
                  {state.status === "idle" ? "Run" : "Run again"}
                </Button>
              )}
            </div>
          )}
        </div>
      </header>

      {hiddenNote === null ? (
        children
      ) : (
        <CenteredMessage className="h-auto flex-1 px-6 text-center">
          {hiddenNote}
        </CenteredMessage>
      )}
    </div>
  );
}

// Under the header: the run's terminal, with its clear button, or the
// ask to run it before there is a run.
export function ConsoleBodyView({
  idle,
  starting,
  onClear,
  children,
}: {
  idle: boolean;
  // Started, with nothing printed yet.
  starting: boolean;
  onClear: (() => void) | null;
  // The terminal (ConsoleTerminalView).
  children: ReactNode;
}) {
  if (idle) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        No runs yet. Press Run to start.
      </div>
    );
  }
  return (
    <div className="relative min-h-0 flex-1 bg-background">
      {children}
      {starting && (
        <div className="pointer-events-none absolute top-3 left-4 font-mono text-xs text-muted-foreground">
          Starting…
        </div>
      )}
      {onClear && (
        <IconButton
          onClick={onClear}
          aria-label="Clear log"
          // Above the terminal, whose hover-revealed scrollbar shares
          // this corner once the output overflows (the terminal wrapper
          // isolates xterm's own z-indexes, so any positive value wins).
          className="absolute top-2 right-3 z-10 text-muted-foreground/60"
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

// The box xterm draws into. Padding lives on the wrapper: the fit addon
// sizes the grid from the host's box width, so padding on the host
// itself would be counted as usable columns. `isolate` keeps xterm's
// internal z-indexes from competing with the console's own controls.
// xterm's stylesheet paints its viewport black and the theme background
// only reaches the scroll element inside it, so the strip below the
// last full row would show black. Letting the console's background
// through fixes that.
export function ConsoleTerminalView({
  hostRef,
}: {
  hostRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      data-slot="script-console"
      data-keyboard-surface="raw"
      className="isolate h-full w-full px-4 py-3 font-mono text-xs"
    >
      <div
        ref={hostRef}
        className="h-full w-full [&_.xterm]:h-full [&_.xterm-viewport]:bg-transparent"
      />
    </div>
  );
}
