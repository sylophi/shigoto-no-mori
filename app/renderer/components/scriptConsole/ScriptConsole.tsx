import { useRef } from "react";
import {
  type TerminalFeed,
  type TerminalScreen,
  TerminalView,
} from "@/components/terminal/TerminalView";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { usePackageScripts } from "@/hooks/scripts/usePackageScripts";
import { useScriptRunner } from "@/hooks/scripts/useScriptRunner";
import { useScriptRuns } from "@/hooks/scripts/useScriptRuns";
import { peerOutputHiddenNote } from "@/lib/commandAccessCopy";
import { openExternalUrl } from "@/lib/openExternal";
import { assertNever } from "@shigomori/ui/lib/utils.ts";
import type { ScriptSlot } from "@/store/scriptRuns";
import type { Worktree } from "@shigomori/contracts/schemas";
import { ScriptConsoleView } from "./ScriptConsoleView";

// A script's console in the drawer, on whichever device the scope
// names: its run-a-slot state, and the run's output in a terminal. The
// output is the run's log in the scoped device's store, replayed and
// then followed. The terminal sizes itself and tells the run's PTY.
export function ScriptConsole({
  worktree,
  slot,
}: {
  worktree: Worktree;
  slot: ScriptSlot;
}) {
  const { key, state, busy, canRun, start, stop, clear } = useScriptRunner(
    worktree,
    slot,
    { follow: true },
  );
  const scriptRuns = useScriptRuns();
  const { data: config } = useShigomoriConfig(worktree.projectId);
  const { data: pkg } = usePackageScripts(worktree.projectId, worktree.id);
  const screen = useRef<TerminalScreen | null>(null);
  const feed: TerminalFeed = (next) => {
    screen.current = next;
    next.replay(scriptRuns.readOutput(key).join(""), true);
    const unsubscribe = scriptRuns.subscribeOutput(key, (chunk) =>
      next.write(chunk),
    );
    return () => {
      unsubscribe();
      screen.current = null;
    };
  };
  return (
    <ScriptConsoleView
      command={resolveCommand(slot, config, pkg)}
      state={state}
      busy={busy}
      readOnlyNote={canRun ? null : peerOutputHiddenNote()}
      onRun={() => void start()}
      onStop={() => void stop()}
      onClear={!busy && state.hasOutput ? clear : null}
      terminal={
        <TerminalView
          // A rerun gets a fresh terminal: xterm applies writes later, so
          // the old run's tail could otherwise paint over the new one.
          key={`${key}:${state.startedAt ?? 0}`}
          feed={feed}
          live={state.status === "running" && state.interactive}
          onInput={(data) => scriptRuns.write(key, data)}
          onFit={(cols, rows) => {
            screen.current?.resize(cols, rows);
            scriptRuns.resize(key, cols, rows);
          }}
          onLink={openExternalUrl}
        />
      }
    />
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
