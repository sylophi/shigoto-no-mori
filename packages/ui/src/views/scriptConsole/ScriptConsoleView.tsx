// A script's console as a tab of the terminal drawer: the command and
// how its run stands over the run's terminal, with Run or Stop.
import type { ReactNode } from "react";
import { Play, Square, Trash2 } from "lucide-react";
import { ScriptStatusBadgeView } from "../shared/ScriptStatusBadgeView.tsx";
import { Button } from "../../primitives/button.tsx";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import type { ScriptRunState } from "../../lib/scriptRun.ts";

export function ScriptConsoleView({
  command,
  state,
  busy,
  readOnlyNote,
  onRun,
  onStop,
  onClear,
  terminal,
}: {
  command: string;
  state: ScriptRunState;
  busy: boolean;
  // Set for a peer that takes no commands from here: nothing runs,
  // stops or shows.
  readOnlyNote: string | null;
  onRun: () => void;
  onStop: () => void;
  // Set while a finished run's output can be dropped.
  onClear: (() => void) | null;
  // The run's terminal (TerminalView).
  terminal: ReactNode;
}) {
  // Lifecycle scripts the engine ran for the app stream here too, but
  // no PTY of the host's sits behind them.
  const outputOnly = busy && !state.interactive;
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-9 shrink-0 items-center gap-3 border-b border-border px-3 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {command && (
            <SimpleTooltip whenTruncated tip={command}>
              <span className="truncate font-mono text-xs text-muted-foreground select-text">
                {command}
              </span>
            </SimpleTooltip>
          )}
          <ScriptStatusBadgeView state={state} />
          {outputOnly && (
            <span className="shrink-0 text-xs text-muted-foreground">
              Output only: the CLI started this run.
            </span>
          )}
        </div>
        {readOnlyNote === null &&
          (busy ? (
            <Button
              variant="outline-destructive"
              size="xs"
              onClick={onStop}
              disabled={state.cancelling}
            >
              <Square />
              {state.cancelling ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button size="xs" onClick={onRun}>
              <Play />
              {state.status === "idle" ? "Run" : "Run again"}
            </Button>
          ))}
      </div>
      {readOnlyNote !== null ? (
        <CenteredMessage className="h-auto flex-1 px-6 text-center">
          {readOnlyNote}
        </CenteredMessage>
      ) : state.status === "idle" ? (
        <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
          No runs yet. Press Run to start.
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {terminal}
          {state.status === "starting" && !state.hasOutput && (
            <div className="pointer-events-none absolute top-2 left-3 font-mono text-xs text-muted-foreground">
              Starting…
            </div>
          )}
          {onClear && (
            <IconButton
              onClick={onClear}
              aria-label="Clear log"
              // Above the terminal, whose scrollbar shares this corner.
              className="absolute top-2 right-3 z-10 text-muted-foreground/60"
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}
