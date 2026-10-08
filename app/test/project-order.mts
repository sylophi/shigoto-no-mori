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
// Split by owner, the owners come in the order their projects lead
// them in over every device, so the filter never reorders them either
// (by name under the alphabetical sort), the projects with no
// remote last, a shut owner is its header alone, and a list of one
// owner draws no header at all. Pinned projects lead the list, above
// the owners when it is split, keep their sort among themselves, and
// are parted from the rest.
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test project-order.
import assert from "node:assert/strict";
import {
  buildSidebarRows,
  projectGroupOrder,
} from "@/components/sidebar/buildSidebarRows";
import type { SidebarRow } from "@/components/sidebar/sidebarRow";
import { sortProjects } from "@/lib/sortProjects";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import {
  ProjectSortModeSchema,
  type Project,
  type ProjectSortMode,
} from "@shared/schemas";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("project-order proof");
console.log("project-order proof\n");

const project = (
  name: string,
  identity: string | null,
  lastUsed: number,
  recentCount: number,
): Project => ({
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

const onPeer = (p: Project): RemoteForestItem => ({
  deviceId: PEER,
  deviceLabel: "Peer",
  deviceIcon: "laptop",
  reachable: true,
  tone: "emerald",
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

// The project with its remote (Project.remote), for the owner checks.
const owned = (p: Project, remoteUrl: string | null): Project => ({
  ...p,
  remote: remoteUrl,
});

const noShelves = () => ({
  agentWorking: new Set(),
  shelved: new Set(),
  hidden: new Set(),
});

// The rows the tree draws, the way Sidebar calls the builder: this
// machine's projects pre-sorted, the order over every device, the rows
// over the filter's pick. `shut` splits the list by owner, with those
// owners shut.
function treeRows({
  sortMode,
  filter,
  stored = local,
  peers = remote,
  shut,
  pinned = new Set(),
  openKey = null,
}: {
  sortMode: ProjectSortMode;
  filter?: string;
  stored?: Project[];
  peers?: RemoteForestItem[];
  shut?: ReadonlySet<string>;
  pinned?: ReadonlySet<string>;
  openKey?: string | null;
}) {
  const ordered = sortProjects(stored, sortMode);
  const showLocal = filter === undefined || filter === "local";
  const projects = showLocal ? ordered : [];
  const { rows } = buildSidebarRows({
    projects,
    worktreeQueries: projects.map(() => ({
      data: [],
      isLoading: false,
      isPending: false,
      error: null,
    })),
    pullRequestQueries: projects.map(() => ({
      data: {},
      isLoading: false,
      isPending: false,
      error: null,
    })),
    openKey,
    worktreeSort: "name",
    order: projectGroupOrder({
      projects: ordered,
      remote: peers,
      sortMode,
      pinned,
    }),
    openShelves: noShelves(),
    hiddenPrefixes: [],
    allowAgentWorking: false,
    byPrefix: null,
    arrangeMode: false,
    byOwner: shut ? { shut } : null,
    remote: filter === undefined || filter === PEER ? peers : [],
    mirrors: [],
    deviceBadges: new Map(),
  });
  return rows;
}

// The group header rows alone.
const headerRows = (
  sortMode: ProjectSortMode,
  filter?: string,
  stored = local,
  peers = remote,
) =>
  treeRows({ sortMode, filter, stored, peers }).filter(
    (r) => r.kind === "project",
  );

// The rows as one line each: an owner's header as `# label`, with its
// count when shut, a project header as its name, any other row as its
// kind. The gap under the pinned projects is a "---".
const outline = (rows: SidebarRow[]) =>
  rows.flatMap((r) =>
    r.kind === "owner-header"
      ? `# ${r.label}${r.expanded ? "" : ` (${r.count})`}`
      : r.kind === "project"
        ? r.pinnedEnd
          ? [r.project.name, "---"]
          : r.project.name
        : r.kind,
  );

const headers = (sortMode: ProjectSortMode, filter?: string) =>
  headerRows(sortMode, filter).map((r) => r.project.name);

// Each narrowed tree is the unfiltered one with the other device's
// groups taken out: this machine's groups by project, the peer's by
// repo (unfiltered, a repo held here too heads as the local project).
function assertFilterKeepsOrder(stored: Project[], peers: RemoteForestItem[]) {
  const narrowed = (mode: ProjectSortMode, filter?: string) =>
    headerRows(mode, filter, stored, peers);
  for (const mode of ProjectSortModeSchema.options) {
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

  // Grouped by owner: alder and birch are acme's (birch through
  // GitHub's case-insensitive owner), dogwood is a user's on another
  // host, cedar has no remote.
  const [alder, birch, cedar] = local as [Project, Project, Project];
  const ownedLocal = [
    owned(alder, "github.com/acme/alder"),
    owned(birch, "github.com/ACME/birch"),
    owned(cedar, null),
  ];
  const ownedRemote = [
    owned(
      project("dogwood", "repo/dogwood", 1000, 2),
      "gitlab.com/zed/dogwood",
    ),
  ].map(onPeer);
  const ownerOutline = (
    sortMode: ProjectSortMode,
    shut: ReadonlySet<string> = new Set(),
  ) =>
    outline(
      treeRows({ sortMode, stored: ownedLocal, peers: ownedRemote, shut }),
    );

  await proof.check("by owner: owners in the projects' sort", () => {
    assert.deepEqual(ownerOutline("manual"), [
      "# acme",
      "alder",
      "birch",
      "# zed",
      "dogwood",
      "# No remote",
      "cedar",
    ]);
  });

  await proof.check("by owner: alphabetical goes by owner name", () => {
    // dogwood is the most recently used, so its owner leads the recent
    // sort, and the alphabetical one puts it back by name.
    assert.deepEqual(ownerOutline("recent"), [
      "# zed",
      "dogwood",
      "# acme",
      "alder",
      "birch",
      "# No remote",
      "cedar",
    ]);
    assert.deepEqual(ownerOutline("alphabetical"), [
      "# acme",
      "alder",
      "birch",
      "# zed",
      "dogwood",
      "# No remote",
      "cedar",
    ]);
  });

  await proof.check("by owner: a shut owner is its header alone", () => {
    assert.deepEqual(ownerOutline("manual", new Set(["github.com/acme"])), [
      "# acme (2)",
      "# zed",
      "dogwood",
      "# No remote",
      "cedar",
    ]);
  });

  await proof.check("by owner: the filter drops owners, never reorders", () => {
    // acme leads on alder here, beta on birch at the peer, and acme's
    // other project trails birch there. Narrowed to the peer, acme
    // keeps the place alder gave it.
    const stored = [owned(alder, "github.com/acme/alder")];
    const peers = [
      owned(project("birch", "repo/birch", 200, 1), "github.com/beta/birch"),
      owned(project("elm", "repo/elm", 100, 1), "github.com/acme/elm"),
    ].map(onPeer);
    const narrowed = (filter?: string) =>
      outline(
        treeRows({
          sortMode: "recent",
          filter,
          stored,
          peers,
          shut: new Set(),
        }),
      );
    assert.deepEqual(narrowed(), ["# acme", "alder", "elm", "# beta", "birch"]);
    assert.deepEqual(narrowed(PEER), ["# acme", "elm", "# beta", "birch"]);
  });

  await proof.check("by owner: one name on two hosts shows its hosts", () => {
    // acme on GitLab too, through abies at the peer, which leads the
    // alphabetical sort of projects. The headers go by what they read,
    // and narrowed to this machine, its acme keeps its host.
    const peers = [
      ...ownedRemote,
      onPeer(
        owned(project("abies", "repo/abies", 0, 0), "gitlab.com/Acme/abies"),
      ),
    ];
    const twoHosts = (filter?: string) =>
      outline(
        treeRows({
          sortMode: "alphabetical",
          filter,
          stored: ownedLocal,
          peers,
          shut: new Set(),
        }),
      );
    assert.deepEqual(twoHosts(), [
      "# github.com/acme",
      "alder",
      "birch",
      "# gitlab.com/Acme",
      "abies",
      "# zed",
      "dogwood",
      "# No remote",
      "cedar",
    ]);
    assert.deepEqual(twoHosts("local"), [
      "# github.com/acme",
      "alder",
      "birch",
      "# No remote",
      "cedar",
    ]);
  });

  await proof.check("by owner: a single owner draws no header", () => {
    const only = (stored: Project[]) =>
      outline(
        treeRows({
          sortMode: "manual",
          stored,
          peers: [],
          shut: new Set(["github.com/acme"]),
        }),
      );
    // All acme's, even shut: one run, nothing folded away.
    assert.deepEqual(only(ownedLocal.slice(0, 2)), ["alder", "birch"]);
    // None with a remote: one run too.
    assert.deepEqual(only([owned(cedar, null)]), ["cedar"]);
    // One owner beside the projects with none is two sections.
    assert.deepEqual(only(ownedLocal), ["# acme (2)", "# No remote", "cedar"]);
  });

  await proof.check("by owner: an open project draws no owners", () => {
    const rows = treeRows({
      sortMode: "manual",
      stored: ownedLocal,
      peers: ownedRemote,
      shut: new Set(),
      openKey: "repo/alder",
    });
    // Its header pins over the rows, and it holds no worktrees here:
    // nothing at all, owner headers included.
    assert.deepEqual(outline(rows), []);
  });

  await proof.check("pinned: lead the list, in the sort", () => {
    // cedar has no identity, so it goes by its id. dogwood is a peer's.
    const pinned = new Set(["id-cedar", "repo/dogwood", "repo/alder"]);
    for (const sortMode of ["manual", "frequent"] as const)
      assert.deepEqual(outline(treeRows({ sortMode, pinned })), [
        "alder",
        "cedar",
        "dogwood",
        "---",
        "birch",
      ]);
    assert.deepEqual(
      outline(treeRows({ sortMode: "manual", pinned, filter: PEER })),
      ["alder", "dogwood", "---", "birch"],
    );
  });

  await proof.check("pinned: lead the owners, which stay put", () => {
    // zed's only project is pinned, and acme keeps the lead.
    const pinned = new Set(["repo/birch", "repo/dogwood"]);
    const rows = (shut: ReadonlySet<string>) =>
      outline(
        treeRows({
          sortMode: "manual",
          stored: ownedLocal,
          peers: ownedRemote,
          shut,
          pinned,
        }),
      );
    assert.deepEqual(rows(new Set()), [
      "birch",
      "dogwood",
      "---",
      "# acme",
      "alder",
      "# No remote",
      "cedar",
    ]);
    // A shut owner keeps its pinned projects out.
    assert.deepEqual(rows(new Set(["github.com/acme"])), [
      "birch",
      "dogwood",
      "---",
      "# acme (1)",
      "# No remote",
      "cedar",
    ]);
  });

  await proof.check("pinned: all of them pinned leaves no gap", () => {
    const pinned = new Set(["repo/alder", "repo/birch", "id-cedar"]);
    assert.deepEqual(
      outline(treeRows({ sortMode: "manual", pinned, peers: [] })),
      ["alder", "birch", "cedar"],
    );
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
