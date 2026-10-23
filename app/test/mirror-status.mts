// Durable proof for the mirror's one-line status (describeMirror in
// ui's views/worktreeDetail/mirror/mirrorStatus.ts). The
// engine runs a cycle on every filesystem event, ignored paths
// included, so a live mirror passes through its scanning states all
// the time without a file moving.
//
// Asserts: after the first pass, the checking states read as Live
// with the watching detail, the states that move files read as
// Syncing, the first pass reads as Syncing throughout, and an engine
// that keeps stopping reads as failing, saying why, where one starting
// reads as restarting. A switch off on the copy's device reads as
// paused until it is on, naming the switch, after a person's pause and
// a halt, and a lost link reads as reconnecting without the engine's
// connect error, which names the device by its id. The switch is this
// device's own when the copy is here and the peer's as its link
// reports it otherwise, sharing first.
//
// Run: pnpm test mirror-status.
import assert from "node:assert/strict";
import type {
  MirrorSession,
  MirrorStatus,
} from "@shigomori/contracts/modules/mirror";
import { copySwitchOff } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { describeMirror } from "@shigomori/ui/views/worktreeDetail/mirror/mirrorStatus.ts";
import { it } from "vitest";
import { mirrorEndpoint, rawMirrorSession } from "./lib/mirrorFakes.mts";

// One file at each end, as a session that has made its first pass.
const endpoint = mirrorEndpoint({ files: 1 });

const view = (
  status: MirrorStatus,
  successfulCycles: number,
  context: Parameters<typeof describeMirror>[1] = {},
  fields: Partial<MirrorSession> = {},
) =>
  describeMirror(
    {
      ...rawMirrorSession({
        session: "s",
        localRoot: "/a",
        deviceId: "B",
        projectId: "p",
        worktreeId: "w",
        remoteRoot: "/b",
        local: endpoint,
        remote: endpoint,
        status,
        successfulCycles,
      }),
      localProjectId: "p",
      localWorktreeId: "w",
      ignoreMode: "everything",
      lastError: "",
      git: { status: "synced", detail: "" },
      ...fields,
    },
    context,
  );

const CHECKING: MirrorStatus[] = [
  "scanning",
  "waiting-for-rescan",
  "reconciling",
  "saving",
];
const MOVING: MirrorStatus[] = [
  "staging-local",
  "staging-remote",
  "transitioning",
];

it("a check after the first pass reads as Live", () => {
  for (const status of CHECKING) {
    const { label, detail, spinning } = view(status, 3);
    assert.deepEqual(
      { label, detail, spinning },
      { label: "Live", detail: "watching for changes", spinning: false },
      status,
    );
  }
});

it("moving files reads as Syncing", () => {
  for (const status of MOVING) {
    assert.equal(view(status, 3).label, "Syncing", status);
  }
});

it("the first pass reads as Syncing", () => {
  for (const status of [...CHECKING, ...MOVING]) {
    assert.equal(view(status, 0).label, "Syncing", status);
  }
  assert.equal(view("scanning", 0).detail, "looking for changes");
});

it("an engine that stopped reads as failing with why, one starting as restarting", () => {
  const failing = view("watching", 3, {
    engine: "failing",
    engineFailure: "stopped with code 2: panic: the session store is locked",
  });
  assert.deepEqual(
    { tone: failing.tone, label: failing.label, detail: failing.detail },
    {
      tone: "rose",
      label: "Engine failing",
      detail:
        "the mirror engine stopped with code 2: panic: the session store is locked, and restarts on its own",
    },
  );
  assert.equal(view("watching", 3, { engine: "starting" }).label, "Restarting");
});

it("a switch off on the copy's device reads as paused until it is on, naming the switch, a person's pause before it, and a lost link as reconnecting without the engine's error, which names the device by its id", () => {
  const refused = {
    lastError:
      "unable to connect to beta: this device is not permitted to run commands on the remote machine",
    git: { status: "off", detail: "" },
  } as const;
  for (const [off, words] of [
    ["control", "Allow control from other devices"],
    ["sharing", "Share with other devices"],
  ] as const) {
    const paused = view(
      "connecting-remote",
      3,
      { copyOff: { device: "Studio Mac", off } },
      refused,
    );
    assert.deepEqual(
      {
        tone: paused.tone,
        label: paused.label,
        detail: paused.detail,
        paused: paused.paused,
      },
      {
        tone: "slate",
        label: "Paused",
        detail: `until Studio Mac turns on “${words}” on its account page`,
        paused: true,
      },
      off,
    );
  }
  const byHand = view(
    "disconnected",
    3,
    { copyOff: { device: "this device", off: "control" } },
    { ...refused, paused: true },
  );
  assert.deepEqual(
    [byHand.label, byHand.detail, byHand.paused],
    ["Paused", "", true],
  );
  const away = { lastError: "no direct connection to 0123456789abcdef" };
  for (const [status, detail] of [
    ["disconnected", "waiting for the other device"],
    ["connecting-remote", "connecting to the other device"],
  ] as const) {
    const lost = view(status, 3, {}, away);
    assert.deepEqual([lost.label, lost.detail], ["Reconnecting", detail]);
  }
});

it("a halt reads as halted whatever the copy's device's switch, since it waits on a person", () => {
  const halted = view(
    "halted-on-root-emptied",
    3,
    { copyOff: { device: "Studio Mac", off: "control" } },
    { git: { status: "off", detail: "" } },
  );
  assert.deepEqual([halted.label, halted.paused], ["Halted", undefined]);
});

it("the switch off on the copy's device is this device's own when the copy is here and the peer's as its link reports it otherwise, sharing first, and one not read yet counts as on", () => {
  const switches = {
    own: { acceptsCommands: false, sharing: true },
    peer: { acceptsCommands: true, sharing: false },
  };
  assert.equal(copySwitchOff({ here: true, ...switches }), "control");
  assert.equal(copySwitchOff({ here: false, ...switches }), "sharing");
  assert.equal(
    copySwitchOff({
      here: false,
      own: { acceptsCommands: false, sharing: false },
      peer: { acceptsCommands: false, sharing: false },
    }),
    "sharing",
  );
  assert.equal(
    copySwitchOff({
      here: true,
      own: {},
      peer: { acceptsCommands: false },
    }),
    undefined,
  );
  assert.equal(
    copySwitchOff({ here: false, own: {}, peer: { sharing: true } }),
    undefined,
  );
});
