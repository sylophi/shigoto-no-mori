// Durable proof for the sidebar tree's two levels: the list of
// projects, and one project on its own (buildSidebarRows in
// renderer/components/sidebar/buildSidebarRows.ts).
//
// Asserts: on the list a project draws its header alone, counting the
// worktrees it holds beside its primary checkouts: the ones it would
// list once open, so shelved and hidden ones stay out, a peer's count,
// and a mirrored pair counts once. No count while its listing is
// loading. Inside a project the tree is that project's header, held
// over the rows rather than among them, and its rows and no other's,
// and an open project the build lacks reads as the list. A worktree reveals nothing from the list or from inside another
// project, and its own row once its project is open. Inside a project
// the worktrees follow its sort, every device's together, primaries
// first.
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test project-fold.
import assert from "node:assert/strict";
import {
  buildSidebarRows,
  projectGroupKey,
  projectGroupOrder,
  remoteWorktreeKey,
  worktreeRowKey,
} from "@/components/sidebar/buildSidebarRows";
import type { SidebarRow } from "@/components/sidebar/sidebarRow";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { Project, Worktree, WorktreeSortMode } from "@shared/schemas";
import { worktree as labWorktree } from "../lab/fixtures.ts";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("project-fold proof");
console.log("project-fold proof\n");

const project = (name: string): Project => ({
  id: `id-${name}`,
  name,
  path: `/src/${name}`,
  pathExists: true,
  identity: `repo/${name}`,
});

const worktree = (
  p: Project,
  name: string,
  marks: Partial<Worktree> = {},
): Worktree =>
  labWorktree({
    id: `${p.name}-${name}`,
    projectId: p.id,
    name,
    branch: name,
    path: `/src/${p.name}-${name}`,
    ...marks,
  });

const lichen = project("lichen");
const portPool = project("port-pool");
const terrier = project("terrier");
const projects = [lichen, portPool, terrier];

const listed = (data: Worktree[] | undefined) => ({
  data,
  isLoading: data === undefined,
  isPending: data === undefined,
  error: null,
});

const PEER = "peer";
// The peer holds port-pool: its primary, a worktree of its own, and
// its end of a pair mirrored with this machine's lease-ttl.
const remote: RemoteForestItem[] = [
  {
    deviceId: PEER,
    deviceLabel: "Peer",
    deviceIcon: "laptop",
    reachable: true,
    tone: "emerald",
    project: portPool,
    worktrees: [
      worktree(portPool, "main", { isPrimary: true }),
      worktree(portPool, "quiet-quail", { createdAt: 300, lastChangeAt: 100 }),
      worktree(portPool, "lease-ttl-copy"),
    ],
    pullRequests: {},
    showPrimaryInInbox: false,
    worktreesError: false,
  },
];

const build = (open: Project | null, worktreeSort: WorktreeSortMode = "name") =>
  buildSidebarRows({
    projects,
    worktreeQueries: [
      listed([
        worktree(lichen, "main", { isPrimary: true }),
        worktree(lichen, "brave-badger"),
        worktree(lichen, "old", { shelved: true }),
        worktree(lichen, "exp/try"),
      ]),
      listed([
        worktree(portPool, "main", { isPrimary: true }),
        worktree(portPool, "zebra"),
        worktree(portPool, "lease-ttl", { createdAt: 200, lastChangeAt: 200 }),
      ]),
      // Still loading.
      listed(undefined),
    ],
    pullRequestQueries: projects.map(() => ({
      data: {},
      isLoading: false,
      isPending: false,
      error: null,
    })),
    openKey: open && projectGroupKey(open, undefined),
    order: projectGroupOrder({ projects, remote, sortMode: "manual" }),
    worktreeSort,
    openShelves: { shelved: new Set(), hidden: new Set() },
    hiddenPrefixes: ["exp/"],
    arrangeMode: false,
    byOwner: null,
    remote,
    mirrors: [
      {
        peerDeviceId: PEER,
        peerWorktreeId: "port-pool-lease-ttl-copy",
        localWorktreeId: "port-pool-lease-ttl",
      },
    ],
    deviceBadges: new Map(),
  });

const line = (row: SidebarRow) => {
  if (row.kind === "project") {
    return `${row.expanded ? "v" : ">"} ${row.project.name} ${row.branches ?? "-"}`;
  }
  if (row.kind === "worktree" || row.kind === "remote-worktree") {
    return row.worktree.name;
  }
  return row.kind;
};

const drawn = (open: Project | null, worktreeSort?: WorktreeSortMode) =>
  build(open, worktreeSort).rows.map(line);

try {
  await proof.check("the list: a line per project, counted", () => {
    assert.deepEqual(drawn(null), [
      // brave-badger. Not the primary, the shelved or the hidden one.
      "> lichen 1",
      // lease-ttl (its mirrored copy on the peer folded into it) and
      // the peer's quiet-quail, and zebra.
      "> port-pool 3",
      "> terrier -",
    ]);
  });

  await proof.check("inside a project: its header and rows alone", () => {
    const { pinned } = build(portPool);
    // The header is held over the rows, not among them.
    assert.equal(pinned && line(pinned), "v port-pool -");
    assert.equal(build(null).pinned, undefined);
    assert.deepEqual(drawn(portPool), [
      "main",
      "main",
      "lease-ttl",
      "quiet-quail",
      "zebra",
    ]);
    assert.equal(build(portPool).level, projectGroupKey(portPool, undefined));
  });

  await proof.check("inside a project: its sort, across devices", () => {
    const worktrees = (sort: WorktreeSortMode) =>
      drawn(portPool, sort).slice(2);
    // Primaries lead every sort, this machine's first.
    assert.deepEqual(drawn(portPool, "created").slice(0, 2), ["main", "main"]);
    assert.equal(build(portPool, "name").rows[0]?.kind, "worktree");
    // The peer's quiet-quail is the newest, zebra's age unknown.
    assert.deepEqual(worktrees("created"), [
      "quiet-quail",
      "lease-ttl",
      "zebra",
    ]);
    // lease-ttl was edited after quiet-quail, zebra never touched.
    assert.deepEqual(worktrees("recent"), [
      "lease-ttl",
      "quiet-quail",
      "zebra",
    ]);
  });

  await proof.check("an open project the build lacks reads as the list", () => {
    const gone = project("gone");
    assert.deepEqual(drawn(gone), drawn(null));
    assert.equal(build(gone).level, null);
    assert.equal(build(null).level, null);
  });

  await proof.check("a worktree reveals only inside its project", () => {
    const local = "port-pool-lease-ttl";
    const peers = "port-pool-quiet-quail";
    assert.equal(build(null).revealKey(portPool.id, local), null);
    assert.equal(build(lichen).revealKey(portPool.id, local), null);
    assert.equal(build(lichen).revealKey(portPool.id, peers, PEER), null);
    assert.equal(
      build(portPool).revealKey(portPool.id, local),
      worktreeRowKey(undefined, local),
    );
    assert.equal(
      build(portPool).revealKey(portPool.id, peers, PEER),
      remoteWorktreeKey(PEER, peers),
    );
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
