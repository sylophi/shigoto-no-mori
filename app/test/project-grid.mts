// Durable proof for the home page's grid of projects
// (renderer/components/home/gridModel.ts), through the very call the
// page makes (buildGrid).
//
// Asserts: the list's project rows file under their owners in the
// list's order, and an unsplit list is one unnamed section. The pinned
// projects lead either as an unnamed section of their own. A tile
// lands on the worktree visited last, wherever it lives, never on a
// shelved, merged or hidden one while the project has another, nor on
// an unreachable device's while a reachable one has one, and falls
// back to one when it has nothing else. A peer's checkout of the same
// repo counts toward its project, and a pull request counts once
// however many worktrees carry its branch.
//
// Run: pnpm test project-grid.
import assert from "node:assert/strict";
import {
  projectGroupKey,
  projectGroupOrder,
  worktreeRowKey,
} from "@shigomori/ui/views/sidebar/buildSidebarRows.ts";
import { buildGrid } from "@shigomori/ui/views/home/gridModel.ts";
import type { RemoteForestItem } from "@shigomori/ui/lib/forest.ts";
import type {
  Project,
  PullRequest,
  Worktree,
} from "@shigomori/contracts/schemas";
import { worktree as fakeWorktree } from "@shigomori/ui/fixtures/fixtures.ts";
import { it } from "vitest";

const PEER = "peer-device";

const project = (name: string, owner: string): Project => ({
  id: `id-${name}`,
  name,
  path: `/src/${name}`,
  pathExists: true,
  identity: `repo/${name}`,
  remote: `github.com/${owner}/${name}`,
});

const worktree = (
  projectId: string,
  id: string,
  branch: string,
  lastChangeAt: number,
  marks: Partial<Worktree> = {},
): Worktree =>
  fakeWorktree({
    id,
    projectId,
    name: id,
    branch,
    path: `/src/${id}`,
    lastChangeAt,
    ...marks,
  });

const pr = (number: number): PullRequest => ({
  number,
  url: `https://example.com/pull/${number}`,
  title: `PR ${number}`,
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
});

const forest = project("forest", "acme");
const lantern = project("lantern", "acme");
const kettle = project("kettle", "rin");
const projects = [forest, lantern, kettle];

const localTrees = [
  [
    worktree(forest.id, "oak", "feat/oak", 300),
    worktree(forest.id, "elm", "feat/elm", 900, { shelved: true }),
    worktree(forest.id, "wip", "wip/scratch", 1000),
  ],
  [worktree(lantern.id, "wick", "fix/wick", 200, { shelved: true })],
  [worktree(kettle.id, "spout", "feat/spout", 100)],
];

// Both of forest's open PRs: feat/oak's is carried by the peer's
// worktree on the same branch too.
const localPullRequests: Record<string, PullRequest>[] = [
  { "feat/oak": pr(1), "feat/elm": pr(2) },
  {},
  {},
];

const peerForest: RemoteForestItem = {
  deviceId: PEER,
  deviceLabel: "Thinkpad",
  deviceIcon: "laptop",
  reachable: true,
  tone: "emerald",
  project: forest,
  worktrees: [
    worktree(forest.id, "pine", "feat/pine", 500),
    worktree(forest.id, "oak-too", "feat/oak", 50),
  ],
  pullRequests: { "feat/oak": pr(1), "feat/pine": pr(3) },
  showPrimaryInInbox: false,
  worktreesError: false,
};

const loaded = <T,>(data: T) => ({
  data,
  isLoading: false,
  isPending: false,
  error: null,
});

function grid(
  visits: Record<string, number> = {},
  byOwner = false,
  peer: RemoteForestItem = peerForest,
  pinned: ReadonlySet<string> = new Set(),
) {
  return buildGrid({
    projects,
    worktreeQueries: localTrees.map(loaded),
    pullRequestQueries: localPullRequests.map(loaded),
    order: projectGroupOrder({
      projects,
      remote: [peerForest],
      sortMode: "manual",
      pinned,
    }),
    hiddenPrefixes: ["wip/"],
    allowAgentWorking: false,
    byOwner,
    remote: [peer],
    mirrors: [],
    deviceBadges: new Map(),
    visits,
  });
}

const work = (visits?: Record<string, number>) => grid(visits).work;
const keyOf = (p: Project) => projectGroupKey(p, undefined);
const leadOf = (visits: Record<string, number>, p: Project) =>
  work(visits).get(keyOf(p))?.lead;

const names = (byOwner: boolean, pinned?: ReadonlySet<string>) =>
  grid({}, byOwner, peerForest, pinned).sections.map((section) => [
    section.label,
    section.rows.map((row) => row.project.name),
  ]);

it("an unsplit list is one unnamed section", () => {
  assert.deepEqual(names(false), [[null, ["forest", "lantern", "kettle"]]]);
});

it("a split list files each project under its owner", () => {
  assert.deepEqual(names(true), [
    ["acme", ["forest", "lantern"]],
    ["rin", ["kettle"]],
  ]);
});

it("the pinned projects are a section of their own", () => {
  const pinned = new Set([keyOf(kettle)]);
  assert.deepEqual(names(false, pinned), [
    [null, ["kettle"]],
    [null, ["forest", "lantern"]],
  ]);
  // Split by owner, the rest are all acme's, which needs no name.
  assert.deepEqual(names(true, pinned), [
    [null, ["kettle"]],
    [null, ["forest", "lantern"]],
  ]);
});

it("a tile lands on the worktree visited last", () => {
  assert.equal(
    leadOf({ [worktreeRowKey(PEER, "pine")]: 20 }, forest)?.key,
    worktreeRowKey(PEER, "pine"),
  );
  assert.equal(
    leadOf({ [worktreeRowKey(undefined, "oak")]: 20 }, forest)?.key,
    worktreeRowKey(undefined, "oak"),
  );
});

it("never a shelved or hidden one while another is", () => {
  const lead = leadOf(
    {
      [worktreeRowKey(undefined, "elm")]: 30,
      [worktreeRowKey(undefined, "wip")]: 40,
    },
    forest,
  );
  // Neither visit counts: with none left, last activity leads.
  assert.equal(lead?.key, worktreeRowKey(PEER, "pine"));
});

it("a reachable device's worktree before one asleep", () => {
  const asleep = grid({}, false, { ...peerForest, reachable: false });
  // pine (500) is the latest, but its peer is off.
  assert.equal(
    asleep.work.get(keyOf(forest))?.lead?.key,
    worktreeRowKey(undefined, "oak"),
  );
});

it("a project with only shelved work lands on it", () => {
  assert.equal(leadOf({}, lantern)?.key, worktreeRowKey(undefined, "wick"));
});

it("a pull request counts once, every device's", () => {
  // #1 on two worktrees, #2 on a shelved one, #3 on the peer.
  assert.equal(work().get(keyOf(forest))?.openPullRequests, 3);
  assert.equal(work().get(keyOf(kettle))?.openPullRequests, 0);
});

it("last activity leaves hidden work out", () => {
  // wip (1000) is hidden. elm (900) is shelved, which still counts.
  assert.equal(work().get(keyOf(forest))?.lastActivity, 900);
});
