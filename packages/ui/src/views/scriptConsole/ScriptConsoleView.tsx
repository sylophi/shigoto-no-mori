// A script's console as a tab of the terminal drawer: Run or Stop at the
// end of the tab row, and under it the command and how its run stands
// over the run's terminal.
import type { ReactNode } from "react";
import { Play, Square, Trash2 } from "lucide-react";
import { ScriptStatusBadgeView } from "../shared/ScriptStatusBadgeView.tsx";
import { Button } from "../../primitives/button.tsx";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import type { ScriptRunState } from "../../lib/scriptRun.ts";
import { TerminalTabToolbar } from "../terminal/TerminalTabsView.tsx";

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
      {readOnlyNote === null && (
        <TerminalTabToolbar>
          {busy ? (
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
          )}
        </TerminalTabToolbar>
      )}
      <div className="flex h-7 shrink-0 items-center gap-3 bg-muted/50 px-3">
        <SimpleTooltip whenTruncated tip={command}>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground select-text">
            <span className="opacity-50 select-none">$ </span>
            {command}
          </span>
        </SimpleTooltip>
        {outputOnly && (
          <span className="truncate text-xs text-muted-foreground">
            Output only: the CLI started this run.
          </span>
        )}
        <ScriptStatusBadgeView state={state} />
        {onClear && (
          <IconButton onClick={onClear} aria-label="Clear log">
            <Trash2 className="size-3.5" />
          </IconButton>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {readOnlyNote !== null ? (
          <CenteredMessage className="px-3 text-center">
            {readOnlyNote}
          </CenteredMessage>
        ) : state.status === "idle" ? (
          <CenteredMessage className="px-3">
            No runs yet. Press Run to start.
          </CenteredMessage>
        ) : (
          <>
            {terminal}
            {state.status === "starting" && !state.hasOutput && (
              <div className="pointer-events-none absolute top-1 left-3 font-mono text-2xs text-muted-foreground">
                Starting…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
