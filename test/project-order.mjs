// Durable proof for the order of the sidebar tree's project groups
// (projectGroupOrder in renderer/components/sidebar/buildSidebarRows.ts).
// The order is decided over every device's projects, so the device
// filter only drops groups and never reshuffles the ones left.
//
// Asserts: the manual sort keeps this machine's arranged order even
// narrowed to a peer that lists the same repos in another order, and
// the repos only peers hold trail it. The usage sorts read a repo on
// several devices as one project: its newest use on any of them, its
// uses on all of them summed. Under every sort, each device's filtered
// tree is the unfiltered one with the other devices' groups taken out.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test project-order.
import assert from "node:assert/strict";
import {
  buildSidebarRows,
  projectGroupOrder,
} from "@/components/sidebar/buildSidebarRows";
import { sortProjects } from "@/lib/sortProjects";
import { makeProof } from "./lib/checkKit.mjs";

const proof = makeProof("project-order proof");
console.log("project-order proof\n");

const project = (name, identity, lastUsed, recentCount) => ({
  id: `id-${name}`,
  name,
  path: `/src/${name}`,
  pathExists: true,
  identity,
  lastUsed,
  recentCount,
});

const PEER = "peer";

// This machine, in its arranged order. "cedar" has no identity, so it
// never matches across devices.
const local = [
  project("alder", "repo/alder", 300, 1),
  project("birch", "repo/birch", 100, 1),
  project("cedar", null, 200, 3),
];

const onPeer = (p) => ({
  deviceId: PEER,
  deviceLabel: "Peer",
  deviceIcon: "laptop",
  reachable: true,
  tone: "green",
  project: p,
  worktrees: [],
  pullRequests: {},
  showPrimaryInInbox: false,
  worktreesError: false,
});

// The peer lists shared repos in another order, and holds "dogwood"
// alone. It used birch last of all and alder most often.
const remote = [
  project("birch", "repo/birch", 900, 1),
  project("dogwood", "repo/dogwood", 50, 2),
  project("alder", "repo/alder", 10, 4),
].map(onPeer);

const noShelves = () => ({ shelved: new Set(), hidden: new Set() });

// The group header rows the tree draws, the way Sidebar calls the
// builder: this machine's projects pre-sorted, the order over every
// device, the rows over the filter's pick.
function headerRows(sortMode, filter, stored = local, peers = remote) {
  const ordered = sortProjects(stored, sortMode);
  const order = projectGroupOrder({
    projects: ordered,
    remote: peers,
    sortMode,
  });
  const showLocal = filter === undefined || filter === "local";
  const projects = showLocal ? ordered : [];
  const { rows } = buildSidebarRows({
    projects,
    worktreeQueries: projects.map(() => ({
      data: [],
      isLoading: false,
      error: null,
    })),
    pullRequestQueries: projects.map(() => ({ data: {} })),
    collapsed: new Set(),
    order,
    openShelves: noShelves(),
    hiddenPrefixes: [],
    arrangeMode: false,
    remote: filter === undefined || filter === PEER ? peers : [],
    mirrors: [],
    deviceBadges: new Map(),
  });
  return rows.filter((r) => r.kind === "project");
}

const headers = (sortMode, filter) =>
  headerRows(sortMode, filter).map((r) => r.project.name);

// Each narrowed tree is the unfiltered one with the other device's
// groups taken out: this machine's groups by project, the peer's by
// repo (unfiltered, a repo held here too heads as the local project).
function assertFilterKeepsOrder(stored, peers) {
  const narrowed = (mode, filter) => headerRows(mode, filter, stored, peers);
  for (const mode of ["manual", "alphabetical", "recent", "frequent"]) {
    const all = narrowed(mode);
    assert.deepEqual(
      narrowed(mode, "local").map((r) => r.project.id),
      all.filter((r) => r.local).map((r) => r.project.id),
      `${mode}, narrowed to this machine`,
    );
    assert.deepEqual(
      narrowed(mode, PEER).map((r) => r.project.identity),
      all
        .filter((r) => !r.local || r.devices.length > 0)
        .map((r) => r.project.identity),
      `${mode}, narrowed to the peer`,
    );
  }
}

try {
  await proof.check(
    "manual: this machine's order, peer-only repos trail",
    () => {
      assert.deepEqual(headers("manual"), [
        "alder",
        "birch",
        "cedar",
        "dogwood",
      ]);
    },
  );

  await proof.check(
    "manual: narrowed to the peer, the local order holds",
    () => {
      assert.deepEqual(headers("manual", PEER), ["alder", "birch", "dogwood"]);
      assert.deepEqual(headers("manual", "local"), ["alder", "birch", "cedar"]);
    },
  );

  await proof.check("recent: a repo's newest use on any device", () => {
    // birch's peer use (900) beats alder's local one (300).
    assert.deepEqual(headers("recent"), ["birch", "alder", "cedar", "dogwood"]);
  });

  await proof.check("frequent: a repo's uses on every device summed", () => {
    // alder 1 + 4, cedar 3, birch 1 + 1, dogwood 2 (tie broken by name).
    assert.deepEqual(headers("frequent"), [
      "alder",
      "cedar",
      "birch",
      "dogwood",
    ]);
  });

  await proof.check("the filter drops groups and never reorders them", () => {
    assertFilterKeepsOrder(local, remote);
  });

  await proof.check("a repo registered twice here ranks one way", () => {
    // The second registration is used more recently here, so the
    // recent sort puts it first and it takes the peer's checkouts. The
    // peer's own recent use of alder must lift that registration and
    // not the first one, or the peer's group jumps when narrowed.
    assertFilterKeepsOrder(
      [...local, project("alder-2", "repo/alder", 400, 2)],
      [
        project("birch", "repo/birch", 900, 1),
        project("alder", "repo/alder", 950, 1),
      ].map(onPeer),
    );
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
