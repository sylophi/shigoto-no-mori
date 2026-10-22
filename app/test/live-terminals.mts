// Durable proof for the terminals on the Live page (buildLive): each
// open terminal goes on its worktree's card, on the device it runs on,
// after the scripts there, named as the drawer's tab for it is, and the
// summary counts them.
//
// Run: pnpm test live-terminals.
import assert from "node:assert/strict";
import { buildLive, summarize } from "@/components/live/liveModel";
import type { RunningScript, Terminal } from "@shigomori/contracts/schemas";
import { terminalTabLabel } from "@/store/terminalDrawer";
import { it } from "vitest";

const terminal = (terminalId: string, worktreeId: string): Terminal => ({
  terminalId,
  projectId: "id-lichen",
  worktreeId,
  openedAt: 0,
});

const run: RunningScript = {
  runId: "run-moss",
  projectId: "id-lichen",
  worktreeId: "moss",
  slot: { kind: "package", name: "dev" },
  startedAt: 0,
  interactive: true,
};

it("puts each terminal on its worktree's card, after its scripts", () => {
  const devices = buildLive({
    agents: [],
    scripts: [
      { deviceId: "mac", api: undefined, runs: [run], loading: false },
      { deviceId: "laptop", api: undefined, runs: [], loading: false },
    ],
    terminals: [
      {
        deviceId: "mac",
        terminals: [
          terminal("a", "fern"),
          terminal("b", "moss"),
          terminal("c", "fern"),
        ],
        loading: false,
      },
      {
        deviceId: "laptop",
        terminals: [terminal("d", "fern")],
        loading: false,
      },
    ],
    mirrors: [],
    forwards: [],
  });
  assert.deepEqual(
    devices.map((device) => [
      device.deviceId,
      device.cards.map((card) => [
        card.worktree?.worktreeId,
        card.items.map((item) =>
          item.kind === "terminal"
            ? `${item.terminal.terminalId}: ${terminalTabLabel(item.index)}`
            : item.kind,
        ),
      ]),
    ]),
    [
      [
        "mac",
        [
          ["moss", ["script", "b: Terminal 1"]],
          ["fern", ["a: Terminal 1", "c: Terminal 2"]],
        ],
      ],
      ["laptop", [["fern", ["d: Terminal 1"]]]],
    ],
  );
  assert.equal(summarize(devices), "1 script and 4 terminals running");
  assert.equal(summarize(devices.slice(1)), "1 terminal running");
});
