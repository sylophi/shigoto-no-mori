// The terminal's parts: a worktree page's drawer with its tabs over a
// script's console, the same over a shell fed a fixture prompt with
// Nerd Font icons, and a peer's drawer while it takes no commands.
import { ScriptConsoleView } from "../views/scriptConsole/ScriptConsoleView.tsx";
import { TerminalDrawerView } from "../views/terminal/TerminalDrawerView.tsx";
import { peerTerminalsHiddenNote } from "../lib/commandAccessCopy.ts";
import { TerminalTabsView } from "../views/terminal/TerminalTabsView.tsx";
import {
  type TerminalFeed,
  TerminalView,
} from "../views/terminal/TerminalView.tsx";
import { MACBOOK_ID } from "../fixtures/fixtures.ts";
import { deviceById } from "./world.ts";

const prompt: TerminalFeed = (screen) => {
  screen.replay(
    "\x1b[32m\uf115 ~/code/forest\x1b[0m on \x1b[35m\ue725 feature/rarity\x1b[0m\r\n$ pnpm test\r\n\r\n \x1b[32m✓\x1b[0m test/rarity.mts (12 tests) 214ms\r\n\r\n Test Files  \x1b[32m1 passed\x1b[0m (1)\r\n      Tests  \x1b[32m12 passed\x1b[0m (12)\r\n\r\n$ ",
    true,
  );
  return () => {};
};

const shell = (
  <TerminalView
    feed={prompt}
    live
    onInput={() => {}}
    onFit={() => {}}
    onLink={() => {}}
  />
);

const tabs = [
  { id: "a", label: "Terminal 1" },
  { id: "b", label: "Terminal 2" },
  { id: "script:dev", label: "dev" },
];

export function TerminalPartsScene() {
  return (
    <div className="grid h-full grid-rows-2">
      <div className="relative flex flex-col justify-end">
        <TerminalDrawerView height={300} onHeight={() => {}}>
          <TerminalTabsView
            tabs={tabs}
            selectedId="script:dev"
            onSelect={() => {}}
            onClose={() => {}}
            onNew={() => {}}
            onHide={() => {}}
          >
            <ScriptConsoleView
              command="vite --port 5173"
              state={{
                runId: "r",
                status: "running",
                hasOutput: true,
                interactive: true,
                exitCode: null,
                startedAt: 0,
                endedAt: null,
                cancelling: false,
              }}
              busy
              readOnlyNote={null}
              onRun={() => {}}
              onStop={() => {}}
              onClear={null}
              terminal={shell}
            />
          </TerminalTabsView>
        </TerminalDrawerView>
      </div>
      <div className="relative flex flex-col justify-end">
        <TerminalDrawerView height={300} onHeight={() => {}}>
          <TerminalTabsView
            tabs={tabs}
            selectedId="b"
            onSelect={() => {}}
            onClose={() => {}}
            onNew={() => {}}
            onHide={() => {}}
          >
            {shell}
          </TerminalTabsView>
        </TerminalDrawerView>
      </div>
    </div>
  );
}

// A peer's drawer while it takes no commands from here: the words in
// place of the tabs.
export function PeerTerminalsHiddenScene() {
  const macbook = deviceById(MACBOOK_ID);
  return (
    <div className="relative flex h-full flex-col justify-end bg-background">
      <TerminalDrawerView height={240} onHeight={() => {}}>
        <TerminalTabsView
          tabs={[]}
          selectedId={null}
          onSelect={() => {}}
          onClose={() => {}}
          onHide={() => {}}
          note={peerTerminalsHiddenNote(macbook.label)}
        >
          {null}
        </TerminalTabsView>
      </TerminalDrawerView>
    </div>
  );
}
