// Durable proof for the sidebar tree's two levels: the list of
// projects, and one project on its own (buildSidebarRows in
// renderer/components/sidebar/buildSidebarRows.ts).
//
// Asserts: on the list a project draws its header alone, counting the
// worktrees it holds beside its primary checkouts: the ones it would
// list once open, so shelved and hidden ones stay out, a peer's count,
// and a mirrored pair counts once. No count while its listing is
// loading. Inside a project the tree is that project's header and rows
// and no other's, and an open project the build lacks reads as the
// list. A worktree reveals nothing from the list or from inside another
// project, and its own row once its project is open.
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
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { Project, Worktree } from "@shared/schemas";
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
      worktree(portPool, "quiet-quail"),
      worktree(portPool, "lease-ttl-copy"),
    ],
    pullRequests: {},
    showPrimaryInInbox: false,
    worktreesError: false,
  },
];

const build = (open: Project | null) =>
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
        worktree(portPool, "lease-ttl"),
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
    openShelves: { shelved: new Set(), hidden: new Set() },
    hiddenPrefixes: ["exp/"],
    arrangeMode: false,
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

const drawn = (open: Project | null) =>
  build(open).rows.map((row) => {
    if (row.kind === "project") {
      return `${row.expanded ? "v" : ">"} ${row.project.name} ${row.branches ?? "-"}`;
    }
    if (row.kind === "worktree" || row.kind === "remote-worktree") {
      return row.worktree.name;
    }
    return row.kind;
  });

try {
  await proof.check("the list: a line per project, counted", () => {
    assert.deepEqual(drawn(null), [
      // brave-badger. Not the primary, the shelved or the hidden one.
      "> lichen 1",
      // lease-ttl (its mirrored copy on the peer folded into it) and
      // the peer's quiet-quail.
      "> port-pool 2",
      "> terrier -",
    ]);
  });

  await proof.check("inside a project: its header and rows alone", () => {
    assert.deepEqual(drawn(portPool), [
      "v port-pool -",
      "main",
      "lease-ttl",
      "main",
      "quiet-quail",
    ]);
    assert.equal(build(portPool).level, projectGroupKey(portPool, undefined));
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
