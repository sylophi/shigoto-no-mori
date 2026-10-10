// The terminal's parts: a worktree page's drawer with its tabs over a
// script's console, a device's own terminals on their page over a
// shell fed a fixture prompt with Nerd Font icons, and the sidebar's
// list of them.
import { ScriptConsoleView } from "@shigomori/ui/views/scriptConsole/ScriptConsoleView.tsx";
import { DeviceTerminalsPageView } from "@shigomori/ui/views/terminal/DeviceTerminalsPageView.tsx";
import { TerminalDrawerView } from "@shigomori/ui/views/terminal/TerminalDrawerView.tsx";
import { TerminalTabsView } from "@shigomori/ui/views/terminal/TerminalTabsView.tsx";
import {
  type TerminalFeed,
  TerminalView,
} from "@shigomori/ui/views/terminal/TerminalView.tsx";
import {
  SidebarDeviceTerminalsView,
  SidebarTerminalsView,
} from "@shigomori/ui/views/sidebar/SidebarTerminalsView.tsx";
import { THINKPAD_ID } from "../fake-host/fixtures";
import { deviceById } from "./world";

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

export function TerminalPartsScene() {
  const thinkpad = deviceById(THINKPAD_ID);
  return (
    <div className="grid h-full grid-cols-[240px_1fr] grid-rows-[300px_1fr]">
      <div className="row-span-2 border-r border-border">
        <SidebarTerminalsView>
          <SidebarDeviceTerminalsView
            label="Studio Mac"
            icon="desktop"
            tone={null}
            terminals={[
              {
                terminalId: "a",
                label: "forest",
                cwd: "/Users/sam/code/forest",
                selected: true,
              },
              {
                terminalId: "b",
                label: "sam",
                cwd: "/Users/sam",
                selected: false,
              },
            ]}
            onPick={() => {}}
          />
          <SidebarDeviceTerminalsView
            label={thinkpad.label}
            icon={thinkpad.icon}
            tone={thinkpad.status.tone}
            terminals={[
              {
                terminalId: "c",
                label: "logs",
                cwd: "/var/logs",
                selected: false,
              },
            ]}
            onPick={() => {}}
          />
        </SidebarTerminalsView>
      </div>
      <div className="flex flex-col justify-end">
        <TerminalDrawerView height={260} onHeight={() => {}}>
          <TerminalTabsView
            tabs={[
              { id: "a", label: "Terminal 1" },
              { id: "b", label: "Terminal 2" },
              { id: "script:dev", label: "dev" },
            ]}
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
      <div className="border-t border-border">
        <DeviceTerminalsPageView deviceName="Studio Mac">
          <TerminalTabsView
            tabs={[{ id: "a", label: "Terminal 1" }]}
            selectedId="a"
            onSelect={() => {}}
            onClose={() => {}}
            onNew={() => {}}
          >
            {shell}
          </TerminalTabsView>
        </DeviceTerminalsPageView>
      </div>
    </div>
  );
}
