// Durable proof for the ⌘K worktree palette's list
// (renderer/components/palette/buildPaletteEntries.ts).
//
// Asserts: every worktree on every device lands in one list, a mirrored
// pair once (as its local row, wearing the peer's badge). Visits lead
// the order, keyed per device so the same worktree id on two machines
// is two entries, and last activity orders the rest. A query matches
// the branch, the folder, "project branch", or a peer's device label.
// The palette opens highlighting the worktree before the one on screen.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test worktree-palette.
import assert from "node:assert/strict";
import {
  buildPaletteEntries,
  initialPaletteKey,
  paletteEntryKey,
  rankPaletteEntries,
} from "@/components/palette/buildPaletteEntries";
import { worktreeVisitKey } from "@/lib/recentWorktrees";
import { makeProof } from "./lib/checkKit.mjs";

const proof = makeProof("worktree-palette proof");
console.log("worktree-palette proof\n");

const PEER = "peer-device";

const project = (name) => ({
  id: `id-${name}`,
  name,
  path: `/src/${name}`,
  pathExists: true,
  identity: `repo/${name}`,
});

const worktree = (projectId, id, branch, lastChangeAt) => ({
  id,
  projectId,
  name: id,
  branch,
  detached: false,
  lastChangeAt,
  recentCommits: [],
  shelved: false,
});

const forest = project("forest");
const lantern = project("lantern");

// This machine: two forest worktrees and one lantern one.
const localTrees = [
  [
    worktree(forest.id, "oak", "feat/oak", 300),
    worktree(forest.id, "shared-id", "feat/moss", 100),
  ],
  [worktree(lantern.id, "wick", "fix/wick", 200)],
];

// The peer holds forest too. "shared-id" is its own worktree that
// happens to carry the same id as one here; "mirror-of-oak" is the
// peer's half of a mirrored pair with the local "oak".
const peerForest = {
  deviceId: PEER,
  deviceLabel: "Thinkpad",
  deviceIcon: "laptop",
  reachable: true,
  tone: "green",
  project: forest,
  worktrees: [
    worktree(forest.id, "shared-id", "feat/fern", 50),
    worktree(forest.id, "mirror-of-oak", "feat/oak", 400),
    worktree(forest.id, "pine", "feat/pine", 500),
  ],
  pullRequests: {},
  showPrimaryInInbox: false,
  worktreesError: false,
};

const mirrors = [
  {
    peerDeviceId: PEER,
    peerWorktreeId: "mirror-of-oak",
    localWorktreeId: "oak",
  },
];

function entries(visits = {}) {
  return buildPaletteEntries({
    projects: [forest, lantern],
    worktreeQueries: localTrees.map((data) => ({
      data,
      isLoading: false,
      error: null,
    })),
    remote: [peerForest],
    mirrors,
    deviceBadges: new Map(),
    visits,
  });
}

const keys = (list) => list.map((entry) => entry.key);
const local = (id) => paletteEntryKey(undefined, id);
const onPeer = (id) => paletteEntryKey(PEER, id);

try {
  await proof.check("every device's worktrees, a mirrored pair once", () => {
    const list = entries();
    assert.deepEqual(keys(list).toSorted(), [
      onPeer("pine"),
      onPeer("shared-id"),
      local("oak"),
      local("shared-id"),
      local("wick"),
    ]);
    const oak = list.find((entry) => entry.key === local("oak"));
    assert.equal(oak.device, undefined, "the local row stands for the pair");
    assert.equal(oak.mirror?.deviceId, PEER, "wearing the peer's badge");
    const pine = list.find((entry) => entry.key === onPeer("pine"));
    assert.equal(pine.device?.label, "Thinkpad");
  });

  await proof.check("with no visits, last activity leads", () => {
    assert.deepEqual(keys(entries()), [
      onPeer("pine"),
      local("oak"),
      local("wick"),
      local("shared-id"),
      onPeer("shared-id"),
    ]);
  });

  await proof.check("visits lead, per device, newest first", () => {
    const list = entries({
      [worktreeVisitKey(PEER, "shared-id")]: 20,
      [worktreeVisitKey(undefined, "wick")]: 10,
    });
    assert.deepEqual(keys(list).slice(0, 3), [
      onPeer("shared-id"),
      local("wick"),
      onPeer("pine"),
    ]);
    // The local worktree with the same id was never visited.
    assert.equal(keys(list).at(-1), local("shared-id"));
  });

  await proof.check("a query matches branch, folder, project, device", () => {
    const list = entries();
    const ranked = (query) => keys(rankPaletteEntries(query, list));
    assert.deepEqual(ranked("wick"), [local("wick")], "branch and folder");
    assert.deepEqual(ranked("lantern fix"), [local("wick")], "project first");
    assert.deepEqual(
      ranked("thinkpad").toSorted(),
      [onPeer("pine"), onPeer("shared-id")],
      "a peer's device label",
    );
    assert.deepEqual(ranked("zzz"), []);
    assert.deepEqual(ranked(""), keys(list), "no query keeps the order");
  });

  await proof.check("opens on the worktree before the one on screen", () => {
    const list = entries({
      [worktreeVisitKey(undefined, "wick")]: 20,
      [worktreeVisitKey(undefined, "oak")]: 10,
    });
    assert.equal(initialPaletteKey(list, local("wick")), local("oak"));
    assert.equal(
      initialPaletteKey(list, undefined),
      local("wick"),
      "off a worktree page, the top row",
    );
    assert.equal(
      initialPaletteKey(list, local("oak")),
      local("wick"),
      "a page that isn't the top row doesn't skip it",
    );
    assert.equal(
      initialPaletteKey(list.slice(0, 1), local("wick")),
      local("wick"),
    );
    assert.equal(initialPaletteKey([], undefined), "");
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
