// Durable proof for a mirrored pair in the inbox under the device
// filter (buildInboxRows in ui's views/sidebar/inbox/, with
// localSidesWith in ui's lib/forest.ts).
//
// Asserts: narrowed to the peer, the inbox lists the pairs as it does
// under every device. This machine's side files as its own, by its own
// primary opt-in, and the peer's row folds into it only from the same
// box, so a primary left out keeps its copy's row and a side on a
// shelf keeps the peer's live one. Narrowed to this machine, the
// copy's page reveals this machine's side, or leaves for the tree
// where that side is a primary the inbox leaves out.
//
// Run: pnpm test inbox-mirror-pair.
import assert from "node:assert/strict";
import { buildInboxRows } from "@shigomori/ui/views/sidebar/inbox/buildInboxRows.ts";
import { worktreeRowKey } from "@shigomori/ui/views/sidebar/buildSidebarRows.ts";
import {
  localSidesWith,
  type RemoteForestItem,
} from "@shigomori/ui/lib/forest.ts";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { worktree as fakeWorktree } from "@shigomori/ui/fixtures/fixtures.ts";
import { it } from "vitest";

const PEER = "peer";

const project: Project = {
  id: "id-port-pool",
  name: "port-pool",
  path: "/src/port-pool",
  pathExists: true,
  identity: "repo/port-pool",
};

const worktree = (name: string, marks: Partial<Worktree> = {}): Worktree =>
  fakeWorktree({
    id: name,
    projectId: project.id,
    name,
    branch: name,
    path: `/src/${name}`,
    ...marks,
  });

const read = <T,>(data: T) => ({
  data,
  isLoading: false,
  isPending: false,
  error: null,
});

// This machine holds only the halves of its pairs with the peer: the
// primary, a live worktree, and one shelved here. The peer's copies
// are all live.
const listings = [
  read([
    worktree("main", { isPrimary: true }),
    worktree("lease-ttl"),
    worktree("old", { shelved: true }),
  ]),
];
// No config: the primary stays out of the inbox (the default).
const configs = [read(null)];
const remote: RemoteForestItem[] = [
  {
    deviceId: PEER,
    deviceLabel: "Peer",
    deviceIcon: "laptop",
    reachable: true,
    tone: "emerald",
    project,
    worktrees: [
      worktree("peer-main", { isPrimary: true }),
      worktree("main-copy"),
      worktree("lease-ttl-copy"),
      worktree("old-copy"),
    ],
    pullRequests: {},
    showPrimaryInInbox: true,
    worktreesError: false,
  },
];
const mirrors = [
  { peerDeviceId: PEER, peerWorktreeId: "main-copy", localWorktreeId: "main" },
  {
    peerDeviceId: PEER,
    peerWorktreeId: "lease-ttl-copy",
    localWorktreeId: "lease-ttl",
  },
  { peerDeviceId: PEER, peerWorktreeId: "old-copy", localWorktreeId: "old" },
];

const inbox = (filter: "all" | "peer" | "local") =>
  buildInboxRows({
    projects: filter === "peer" ? [] : [project],
    worktreeQueries: filter === "peer" ? [] : listings,
    pullRequestQueries: filter === "peer" ? [] : [read({})],
    configQueries: filter === "peer" ? [] : configs,
    remote: filter === "local" ? [] : remote,
    mirrors,
    localSides:
      filter === "peer"
        ? localSidesWith(PEER, mirrors, [project], listings, configs)
        : undefined,
    deviceBadges: new Map(),
    openShelves: new Set(),
    hiddenPrefixes: [],
    groupedPrefixes: [],
    shutGroups: new Set(),
    allowAgentWorking: false,
    pinWaiting: false,
  });

it("narrowed to the peer, the pairs read as on every device", () => {
  const keys = (filter: "all" | "peer") =>
    inbox(filter).rows.map((row) => row.key);
  // The peer's primary, the copy of the primary left out here, the
  // pair, the live copy of the one shelved here, and the shelf that
  // one waits on.
  assert.deepEqual(keys("all").toSorted(), [
    worktreeRowKey(PEER, "main-copy"),
    worktreeRowKey(PEER, "old-copy"),
    worktreeRowKey(PEER, "peer-main"),
    "shelf:shelved",
    worktreeRowKey(undefined, "lease-ttl"),
  ]);
  assert.deepEqual(keys("peer"), keys("all"));
  for (const filter of ["all", "peer"] as const) {
    const view = inbox(filter);
    // The primary's page leaves the inbox for the tree, as it would.
    assert.equal(view.leftOut?.("main", undefined), true);
    assert.equal(
      view.revealKey(project.id, "lease-ttl-copy", PEER),
      worktreeRowKey(undefined, "lease-ttl"),
    );
  }
});

it("narrowed to this machine, the copy's page reveals its side", () => {
  const view = inbox("local");
  assert.equal(
    view.revealKey(project.id, "lease-ttl-copy", PEER),
    worktreeRowKey(undefined, "lease-ttl"),
  );
  // The side on a shut shelf: the shelf opens for it.
  assert.equal(view.revealKey(project.id, "old-copy", PEER), "shelf:shelved");
  // The side a primary the inbox leaves out: the page leaves for the
  // tree, as the primary's own does.
  assert.equal(view.leftOut?.("main-copy", PEER), true);
  assert.equal(inbox("all").leftOut?.("main-copy", PEER), false);
});
