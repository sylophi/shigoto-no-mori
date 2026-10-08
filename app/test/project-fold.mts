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
// first. Inline, the list draws every project's rows under its header,
// each in its own sort, and a folded project's header stands in for
// its rows.
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
import type {
  Project,
  PullRequest,
  Worktree,
  WorktreeSortMode,
} from "@shared/schemas";
import { worktree as fakeWorktree } from "../lab/fake-host/fixtures.ts";
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
  fakeWorktree({
    id: `${p.name}-${name}`,
    projectId: p.id,
    name,
    branch: name,
    path: `/src/${p.name}-${name}`,
    ...marks,
  });

const pr = (number: number, baseRefName: string): PullRequest => ({
  number,
  url: `https://example.com/pull/${number}`,
  title: `PR ${number}`,
  state: "OPEN",
  isDraft: false,
  baseRefName,
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

const build = (
  open: Project | null,
  worktreeSort: WorktreeSortMode = "name",
  byPrefix: Parameters<typeof buildSidebarRows>[0]["byPrefix"] = null,
  pullRequests: Record<string, PullRequest> = {},
  args: Partial<Parameters<typeof buildSidebarRows>[0]> = {},
) =>
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
      data: pullRequests,
      isLoading: false,
      isPending: false,
      error: null,
    })),
    openKey: open && projectGroupKey(open, undefined),
    inline: null,
    order: projectGroupOrder({
      projects,
      remote,
      sortMode: "manual",
      pinned: new Set(),
    }),
    worktreeSort: () => worktreeSort,
    openShelves: {
      agentWorking: new Set(),
      shelved: new Set(),
      hidden: new Set(),
    },
    hiddenPrefixes: ["exp/"],
    allowAgentWorking: false,
    byPrefix,
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
    ...args,
  });

const pinnedEnd = (rows: SidebarRow[]) =>
  rows.some((row) => row.kind === "project" && row.pinnedEnd === true);

const withRemote = (p: Project, owner: string): Project => ({
  ...p,
  remote: `github.com/${owner}/${p.name}`,
});

const line = (row: SidebarRow) => {
  if (row.kind === "project") {
    const open = row.expanded || row.folded === false;
    return `${open ? "v" : ">"} ${row.project.name} ${row.branches ?? "-"}`;
  }
  if (row.kind === "worktree" || row.kind === "remote-worktree") {
    return row.worktree.name;
  }
  if (row.kind === "worktree-group") {
    return `${row.expanded ? "v" : ">"} ${row.prefix} ${row.count}`;
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

  await proof.check(
    "inside a project: a prefix's rows under its header",
    () => {
      const grouped = (shut: string[] = []) =>
        build(portPool, "name", {
          prefixes: ["lease-", "quiet-"],
          shut: (groupId, prefix) =>
            groupId === portPool.id && shut.includes(prefix),
        });
      // The rest first, then a header per prefix in the list's order,
      // every device's rows together, a mirrored pair once.
      assert.deepEqual(grouped().rows.map(line), [
        "main",
        "main",
        "zebra",
        "v lease- 1",
        "lease-ttl",
        "v quiet- 1",
        "quiet-quail",
      ]);
      // Shut, the header stands in for its rows, and reveals them.
      const shut = grouped(["quiet-"]);
      assert.deepEqual(shut.rows.map(line).slice(-2), [
        "lease-ttl",
        "> quiet- 1",
      ]);
      assert.equal(
        shut.revealKey(portPool.id, "port-pool-quiet-quail", PEER),
        `g:${portPool.id}:quiet-`,
      );
      // The list's count is unchanged: grouped rows are still listed.
      const list = build(null, "name", {
        prefixes: ["lease-"],
        shut: () => true,
      });
      assert.deepEqual(list.rows.map(line), drawn(null));
      // A hidden prefix outranks a group: exp/try stays behind its fold.
      const lichenRows = build(lichen, "name", {
        prefixes: ["exp/"],
        shut: () => false,
      }).rows.map(line);
      assert.equal(lichenRows.includes("v exp/ 1"), false);
      assert.equal(lichenRows.at(-1), "shelved-toggle");
    },
  );

  await proof.check("a stack goes whole where its lowest layer files", () => {
    // zebra is stacked on lease-ttl.
    const stacked = { "lease-ttl": pr(1, "main"), zebra: pr(2, "lease-ttl") };
    const grouped = (prefixes: string[]) =>
      build(
        portPool,
        "name",
        { prefixes, shut: () => false },
        stacked,
      ).rows.map(line);
    // zebra follows its bottom layer under lease-, top layer first.
    assert.deepEqual(grouped(["lease-"]), [
      "main",
      "main",
      "quiet-quail",
      "v lease- 2",
      "zebra",
      "lease-ttl",
    ]);
    // A prefix only the top layer matches leaves the stack where its
    // bottom layer sits.
    assert.deepEqual(grouped(["zebra"]), [
      "main",
      "main",
      "zebra",
      "lease-ttl",
      "quiet-quail",
    ]);
  });

  await proof.check("inline: every project's rows under its header", () => {
    const inline = (collapsed: Project[] = []) =>
      build(
        lichen,
        "name",
        null,
        {},
        {
          inline: {
            collapsed: { has: (id) => collapsed.some((p) => p.id === id) },
          },
          // port-pool by creation, the rest by name.
          worktreeSort: (groupKey) =>
            groupKey === projectGroupKey(portPool, undefined)
              ? "created"
              : "name",
        },
      );
    // The open project goes unread: there is no level to be inside.
    const { rows, pinned, level } = inline();
    assert.equal(pinned, undefined);
    assert.equal(level, undefined);
    assert.deepEqual(rows.map(line), [
      "v lichen -",
      "main",
      "brave-badger",
      "shelved-toggle",
      "shelved-toggle",
      "v port-pool -",
      "main",
      "main",
      "quiet-quail",
      "lease-ttl",
      "zebra",
      "v terrier -",
      "worktree-skeleton",
    ]);
    // Folded, a project is its header, counted, which stands in for
    // every one of its rows, a peer's too.
    const folded = inline([portPool]);
    assert.deepEqual(folded.rows.map(line).slice(5, 7), [
      "> port-pool 3",
      "v terrier -",
    ]);
    const header = `p:${portPool.id}`;
    assert.equal(folded.revealKey(portPool.id, "port-pool-lease-ttl"), header);
    assert.equal(
      folded.revealKey(portPool.id, "port-pool-quiet-quail", PEER),
      header,
    );
    assert.equal(
      inline().revealKey(portPool.id, "port-pool-lease-ttl"),
      worktreeRowKey(undefined, "port-pool-lease-ttl"),
    );
  });

  await proof.check("inline: a project's rows go with it", () => {
    const inline = (collapsed: Project[]) =>
      build(
        lichen,
        "name",
        null,
        {},
        {
          inline: {
            collapsed: { has: (id) => collapsed.some((p) => p.id === id) },
          },
          order: projectGroupOrder({
            projects,
            remote,
            sortMode: "manual",
            pinned: new Set([projectGroupKey(portPool, undefined)]),
          }),
        },
      ).rows;
    // Pinned, port-pool leads with its rows, and the gap under the
    // pinned run waits for a header alone.
    const open = inline([]);
    assert.deepEqual(open.map(line).slice(0, 7), [
      "v port-pool -",
      "main",
      "main",
      "lease-ttl",
      "quiet-quail",
      "zebra",
      "v lichen -",
    ]);
    assert.equal(pinnedEnd(open), false);
    assert.equal(pinnedEnd(inline([portPool])), true);
  });

  await proof.check(
    "inline: split by owner, rows stay with their project",
    () => {
      // lichen and terrier are one owner's, port-pool another's.
      const owned = [
        withRemote(lichen, "a"),
        withRemote(portPool, "b"),
        withRemote(terrier, "a"),
      ];
      const split = (shut: string[], collapsed: Project[] = []) =>
        build(
          lichen,
          "name",
          null,
          {},
          {
            projects: owned,
            inline: {
              collapsed: { has: (id) => collapsed.some((p) => p.id === id) },
            },
            order: projectGroupOrder({
              projects: owned,
              remote: [],
              sortMode: "manual",
              pinned: new Set(),
            }),
            byOwner: { shut: new Set(shut) },
            remote: [],
            mirrors: [],
          },
        );
      const rows = split([]).rows.map((row) =>
        row.kind === "owner-header" ? row.label : line(row),
      );
      // A shut owner's header stands in for its projects' rows, a
      // folded project's too.
      const ownerB = "o:github.com/b";
      for (const collapsed of [[], [portPool]]) {
        assert.equal(
          split(["github.com/b"], collapsed).revealKey(
            portPool.id,
            "port-pool-lease-ttl",
          ),
          ownerB,
        );
      }
      assert.deepEqual(rows, [
        "a",
        "v lichen -",
        "main",
        "brave-badger",
        "shelved-toggle",
        "shelved-toggle",
        "v terrier -",
        "worktree-skeleton",
        "b",
        "v port-pool -",
        "main",
        "lease-ttl",
        "zebra",
      ]);
    },
  );

  proof.done();
} catch (error) {
  proof.fail(error);
}
