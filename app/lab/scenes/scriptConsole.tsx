// A script's console over the fixtures: brave-badger's dev server
// starting, and the console before a run and on a peer that shows no
// output.
import type { ReactNode } from "react";
import {
  ConsoleBodyView,
  ConsoleTerminalView,
  ScriptConsolePageView,
} from "@/components/scriptConsole/ScriptConsoleView";
import { peerOutputHiddenNote } from "@/lib/commandAccessCopy";
import type { ScriptRunState } from "@/store/scriptRuns";
import { SceneWindowFrame } from "./frame";
import { SceneSidebar } from "./sidebar";

const noop = () => {};

function consolePage(
  state: ScriptRunState,
  hiddenNote: string | null,
  body: ReactNode,
) {
  return (
    <SceneWindowFrame
      sidebar={<SceneSidebar view="projects" open />}
      pathname="/projects"
    >
      <ScriptConsolePageView
        back={{ label: "brave-badger", onClick: noop }}
        label="dev"
        command="vite"
        state={state}
        outputOnly={false}
        run={
          hiddenNote === null
            ? {
                busy: state.status === "running" || state.status === "starting",
                onStart: noop,
                onStop: noop,
              }
            : null
        }
        hiddenNote={hiddenNote}
      >
        {body}
      </ScriptConsolePageView>
    </SceneWindowFrame>
  );
}

const RUN: ScriptRunState = {
  runId: "run-sm-badger-dev",
  status: "starting",
  hasOutput: false,
  interactive: true,
  exitCode: null,
  startedAt: Date.now(),
  endedAt: null,
  cancelling: false,
};

// brave-badger's dev server, just started.
export function ScriptConsoleScene() {
  return consolePage(
    RUN,
    null,
    <ConsoleBodyView idle={false} starting onClear={null}>
      <ConsoleTerminalView />
    </ConsoleBodyView>,
  );
}

// Before its first run, and on a peer that shows no output.
export function ScriptConsolePartsScene() {
  const idle: ScriptRunState = {
    ...RUN,
    runId: null,
    status: "idle",
    startedAt: null,
  };
  return (
    <div className="grid h-full grid-cols-2 overflow-hidden">
      {consolePage(
        idle,
        null,
        <ConsoleBodyView idle starting={false} onClear={null}>
          {null}
        </ConsoleBodyView>,
      )}
      {consolePage(idle, peerOutputHiddenNote("Thinkpad"), null)}
    </div>
  );
}
