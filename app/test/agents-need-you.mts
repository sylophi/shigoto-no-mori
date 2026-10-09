// Durable proof for where agents waiting on you go. The inbox
// (inboxRank): a worktree whose agent waits on you leads its box while
// the mark shows, the longest wait first, and drops back once answered
// or with the mark off. An agent session changing state counts as
// activity, so a turn lifts its worktree like an edit would. The Live
// page (buildLive): a waiting agent leads its worktree's card, and that
// card leads its device's.
//
// Run: pnpm test agents-need-you.
import assert from "node:assert/strict";
import { buildLive } from "@/components/live/liveModel";
import { byInboxRank, inboxRank } from "@/components/sidebar/inbox/inboxRank";
import {
  type AgentSession,
  type RunningScript,
  type Worktree,
  worktreeLastActivityAt,
} from "@shigomori/contracts/schemas";
import { worktree as fakeWorktree } from "../lab/fake-host/fixtures.ts";
import { it } from "vitest";

const session = (state: AgentSession["state"], at: number): AgentSession => ({
  harness: "claude",
  session: `s-${state}-${at}`,
  state,
  at,
});

const worktree = (name: string, marks: Partial<Worktree> = {}): Worktree =>
  fakeWorktree({
    id: `lichen-${name}`,
    projectId: "id-lichen",
    name,
    branch: name,
    path: `/src/lichen-${name}`,
    ...marks,
  });

const run = (worktreeId: string): RunningScript => ({
  runId: `run-${worktreeId}`,
  projectId: "id-lichen",
  worktreeId,
  slot: { kind: "package", name: "dev" },
  startedAt: 0,
  interactive: false,
});

const order = (trees: Worktree[], pinWaiting: boolean) =>
  trees
    .map((w) => inboxRank(w, pinWaiting))
    .toSorted(byInboxRank)
    .map((rank) => rank.worktree.name);

const trees = [
  worktree("fresh", { lastChangeAt: 900 }),
  worktree("asked-late", {
    lastChangeAt: 100,
    agentSessions: [session("waiting", 300)],
  }),
  worktree("asked-early", {
    lastChangeAt: 50,
    agentSessions: [session("idle", 20), session("waiting", 200)],
  }),
  worktree("quiet", { lastChangeAt: 10 }),
];

it("waiting worktrees lead, the longest wait first", () => {
  assert.deepEqual(order(trees, true), [
    "asked-early",
    "asked-late",
    "fresh",
    "quiet",
  ]);
});

it("a worktree ranks by its longest wait", () => {
  const both = worktree("both", {
    agentSessions: [session("waiting", 100), session("waiting", 400)],
  });
  assert.deepEqual(order([...trees, both], true).slice(0, 3), [
    "both",
    "asked-early",
    "asked-late",
  ]);
});

it("with the mark off, recency alone", () => {
  assert.deepEqual(order(trees, false), [
    "fresh",
    "asked-late",
    "asked-early",
    "quiet",
  ]);
});

it("an agent's state change counts as activity", () => {
  const answered = worktree("answered", {
    lastChangeAt: 100,
    agentSessions: [session("working", 950)],
  });
  assert.equal(worktreeLastActivityAt(answered), 950);
  assert.deepEqual(order([...trees, answered], true), [
    "asked-early",
    "asked-late",
    "answered",
    "fresh",
    "quiet",
  ]);
});

it("Live: the waiting agent's card leads its device", () => {
  const [device] = buildLive({
    agents: [
      {
        deviceId: "d1",
        projectId: "id-lichen",
        worktreeId: "asked",
        session: session("waiting", 300),
      },
    ],
    scripts: [
      {
        deviceId: "d1",
        api: undefined,
        runs: [run("serving"), run("asked")],
        loading: false,
      },
    ],
    mirrors: [],
    forwards: [],
  });
  assert.deepEqual(
    device?.cards.map((card) => [
      card.worktree?.worktreeId,
      card.items.map((item) => item.kind),
    ]),
    [
      ["asked", ["agent", "script"]],
      ["serving", ["script"]],
    ],
  );
});
