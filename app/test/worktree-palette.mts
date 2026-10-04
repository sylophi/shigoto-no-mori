// Durable proof for the ⌘K worktree palette's list
// (renderer/components/palette/buildPaletteEntries.ts).
//
// Asserts: every worktree on every device lands in one list, a mirrored
// pair once (as its local row, wearing the peer's badge). Visits lead
// the order, keyed per device so the same worktree id on two machines
// is two entries, and last activity orders the rest, merged and
// shelved ones last. A query matches the branch, the folder, "project
// branch", a peer's device label, or the pull request by number or
// title (a space in it standing for any gap), sinking merged work under
// live work that matches as well, and a hidden-prefix worktree shows
// only for one. The palette opens highlighting the worktree before the
// one on screen, a mirrored peer's page counting as its local row. A
// query names projects once across devices, those with no worktrees and
// those only a peer holds too, and they go above the worktrees when the
// query names a project best. A query turns into a branch name
// git takes (a pasted path or URL never does), and a new worktree goes to
// the project on screen first. The matched letters are the ones the
// ranking matched.
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test worktree-palette.
import assert from "node:assert/strict";
import {
  buildPaletteEntries,
  createTargets,
  initialPaletteKey,
  isProjectSource,
  newBranchName,
  leadingProjectCount,
  rankPaletteEntries,
  rankPaletteProjects,
  type PaletteEntry,
} from "@/components/palette/buildPaletteEntries";
import { matchPositions } from "@/lib/fuzzyMatch";
import { worktreeRowKey } from "@/components/sidebar/buildSidebarRows";
import type { MirrorLink } from "@/hooks/remote/useMirrors";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import { worktree as fakeWorktree } from "../lab/fake-host/fixtures.ts";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("worktree-palette proof");
console.log("worktree-palette proof\n");

const PEER = "peer-device";

const project = (name: string): Project => ({
  id: `id-${name}`,
  name,
  path: `/src/${name}`,
  pathExists: true,
  identity: `repo/${name}`,
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
// happens to carry the same id as one here. "mirror-of-oak" is the
// peer's half of a mirrored pair with the local "oak".
const peerForest: RemoteForestItem = {
  deviceId: PEER,
  deviceLabel: "Thinkpad",
  deviceIcon: "laptop",
  reachable: true,
  tone: "emerald",
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

const mirrors: MirrorLink[] = [
  {
    peerDeviceId: PEER,
    peerWorktreeId: "mirror-of-oak",
    localWorktreeId: "oak",
  },
];

const loaded = <T,>(data: T) => ({
  data,
  isLoading: false,
  isPending: false,
  error: null,
});

// Lantern's fix/wick has pull request #148 open.
const localPullRequests: Record<string, PullRequest>[] = [
  {},
  {
    "fix/wick": {
      number: 148,
      url: "https://example.com/pull/148",
      title: "Trim the wick",
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
    },
  },
];

function palette(
  visits: Record<string, number> = {},
  hiddenPrefixes: string[] = [],
  trees: Worktree[][] = localTrees,
) {
  return buildPaletteEntries({
    projects: [forest, lantern],
    worktreeQueries: trees.map(loaded),
    pullRequestQueries: localPullRequests.map(loaded),
    remote: [peerForest],
    mirrors,
    deviceBadges: new Map(),
    hiddenPrefixes,
    visits,
  });
}

const entries = (visits?: Record<string, number>) => palette(visits).entries;

const keys = (list: readonly PaletteEntry[]) => list.map((entry) => entry.key);
const ids = (projects: readonly Project[]) => projects.map((p) => p.id);
const local = (id: string) => worktreeRowKey(undefined, id);
const onPeer = (id: string) => worktreeRowKey(PEER, id);

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
    assert.ok(oak);
    assert.equal(oak.device, undefined, "the local row stands for the pair");
    assert.equal(oak.mirror?.deviceId, PEER, "wearing the peer's badge");
    const pine = list.find((entry) => entry.key === onPeer("pine"));
    assert.ok(pine);
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
      [onPeer("shared-id")]: 20,
      [local("wick")]: 10,
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
    const ranked = (query: string) => keys(rankPaletteEntries(query, list));
    assert.deepEqual(ranked("wick"), [local("wick")], "branch and folder");
    assert.deepEqual(ranked("lantern fix"), [local("wick")], "project first");
    assert.deepEqual(
      ranked("thinkpad").toSorted(),
      [onPeer("pine"), onPeer("shared-id")],
      "a peer's device label",
    );
    assert.deepEqual(ranked("fix wi"), [local("wick")], "a space as a gap");
    assert.deepEqual(ranked("zzz"), []);
    assert.deepEqual(ranked(""), keys(list), "no query keeps the order");
  });

  await proof.check("opens on the worktree before the one on screen", () => {
    const list = entries({
      [local("wick")]: 20,
      [local("oak")]: 10,
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

  await proof.check("a mirrored peer's page stands for its local row", () => {
    const peerPage = onPeer("mirror-of-oak");
    const { entries: list, entryKeyOf } = palette({
      [peerPage]: 30,
      [local("wick")]: 20,
    });
    assert.equal(entryKeyOf(peerPage), local("oak"));
    assert.equal(entryKeyOf(onPeer("pine")), onPeer("pine"));
    assert.equal(list[0]?.key, local("oak"), "the peer's visit lifts it");
    assert.equal(
      initialPaletteKey(list, entryKeyOf(peerPage)),
      local("wick"),
      "and the palette opens past it",
    );
  });

  await proof.check("hidden prefixes wait for a query", () => {
    const { entries: list } = palette({}, ["fix/"]);
    const ranked = (query: string) => keys(rankPaletteEntries(query, list));
    assert.ok(!ranked("").includes(local("wick")), "not listed unasked");
    assert.deepEqual(ranked("wick"), [local("wick")], "found by name");
  });

  await proof.check("merged and shelved sink, and still come up", () => {
    const trees = [
      [
        worktree(forest.id, "oak", "feat/oak", 300, {
          mergedIntoPrimary: true,
        }),
        worktree(forest.id, "shared-id", "feat/moss", 100, { shelved: true }),
      ],
      [worktree(lantern.id, "wick", "fix/wick", 200)],
    ];
    const list = palette({ [local("oak")]: 99 }, [], trees).entries;
    assert.deepEqual(keys(list).slice(-2), [local("oak"), local("shared-id")]);
    const ranked = (q: string) => keys(rankPaletteEntries(q, list));
    assert.deepEqual(ranked("oak"), [local("oak")], "a query still finds it");
    // "feat" names both merged oak and the peer's live pine as well.
    assert.equal(ranked("feat")[0], onPeer("pine"), "live work leads");
  });

  await proof.check("a pull request by number or title", () => {
    const list = entries();
    const ranked = (q: string) => keys(rankPaletteEntries(q, list));
    assert.deepEqual(ranked("#148"), [local("wick")]);
    assert.equal(ranked("trim the")[0], local("wick"));
    const wick = list.find((entry) => entry.key === local("wick"));
    assert.ok(wick);
    assert.equal(wick.pr?.number, 148);
  });

  await proof.check("a project is one row across its devices", () => {
    const [row, ...rest] = rankPaletteProjects(
      "forest",
      entries(),
      [forest, lantern],
      [peerForest],
    );
    assert.ok(row);
    assert.equal(rest.length, 0);
    assert.equal(row.project.id, forest.id, "named for its local checkout");
    assert.equal(row.device, undefined);
    assert.equal(row.worktreeCount, 4, "oak, moss here; fern, pine there");
    assert.equal(row.deviceCount, 2);
    assert.equal(row.lead?.key, onPeer("pine"), "↩ goes where the list leads");
    assert.equal(row.localProject?.id, forest.id);
    assert.deepEqual(
      rankPaletteProjects("", entries(), [forest, lantern], [peerForest]),
      [],
      "only asked",
    );
  });

  await proof.check("a project with no worktrees is found too", () => {
    const meadow = project("meadow");
    const reed = project("reed");
    const peerReed: RemoteForestItem = {
      ...peerForest,
      project: reed,
      worktrees: [],
    };
    const projects = [forest, lantern, meadow];
    const remote = [peerForest, peerReed];
    const [here] = rankPaletteProjects("meadow", entries(), projects, remote);
    assert.equal(here?.project.id, meadow.id);
    assert.equal(here?.lead, undefined, "↩ opens its new-worktree page");
    assert.equal(here?.worktreeCount, 0);
    assert.equal(here?.localProject?.id, meadow.id);
    const [gone] = rankPaletteProjects(
      "gone",
      entries(),
      [{ ...project("gone"), pathExists: false }],
      [],
    );
    assert.equal(gone, undefined, "no folder, nothing to open");
    const offline: RemoteForestItem = {
      ...peerReed,
      deviceId: "offline-device",
      reachable: false,
    };
    const [reachable] = rankPaletteProjects(
      "reed",
      [],
      [],
      [offline, peerReed],
    );
    assert.equal(
      reachable?.device?.deviceId,
      PEER,
      "named by a reachable peer",
    );
    assert.equal(reachable?.deviceCount, 2);
    const [there] = rankPaletteProjects("reed", entries(), projects, remote);
    assert.equal(there?.project.id, reed.id);
    assert.equal(there?.device?.deviceId, PEER, "only the peer holds it");
    assert.equal(there?.localProject, undefined);
    assert.equal(there?.deviceCount, 1);
  });

  await proof.check("projects lead when the query names one best", () => {
    const list = entries();
    const leading = (query: string, projects = [forest, lantern]) =>
      leadingProjectCount(
        query,
        rankPaletteProjects(query, list, projects, [peerForest]),
        rankPaletteEntries(query, list),
      );
    assert.equal(leading("forest"), 1, "its name");
    assert.equal(leading("lant"), 1, "the start of it");
    assert.equal(leading("oak"), 0, "a branch");
    assert.equal(leading("forest oak"), 0, "a project's branch");
    assert.equal(leading("thinkpad"), 0, "a device, no project");
    assert.equal(leading("zzz", [project("zzz")]), 1, "no worktree matches");
    assert.equal(
      leading("fern", [project("fern"), project("f-e-r-n")]),
      1,
      "letters scattered through a name trail a worktree that spells them",
    );
  });

  await proof.check("a query as a new branch", () => {
    assert.equal(newBranchName("fix st"), "fix-st");
    assert.equal(newBranchName("  feat/oak  "), "feat/oak");
    assert.equal(
      newBranchName("a..b~c^d:e?f*g[h\\i"),
      "a.b-c-d-e-f-g-h-i",
      "the branch inputs' own filter",
    );
    assert.equal(newBranchName("café fix"), "caf--fix", "as the form has it");
    assert.equal(newBranchName("-/x//y/."), "x/y");
    assert.equal(newBranchName("wip.lock"), "wip");
    assert.equal(newBranchName("x/.lock"), "x/lock", "no dot-led component");
    assert.equal(newBranchName("feat/.hidden"), "feat/hidden");
    assert.equal(newBranchName("a.lock/b"), "a/b", "no .lock component");
    assert.equal(newBranchName("x.lock.lock"), "x");
    assert.equal(newBranchName(" ~^ "), null);
    assert.ok(isProjectSource("~/src/thing"));
    assert.ok(isProjectSource("git@github.com:me/thing.git"));
    assert.ok(isProjectSource("https://github.com/me/thing"));
    assert.ok(isProjectSource("gitlab.example.com:group/repo"), "scp-style");
    assert.ok(!isProjectSource("fix st"));
  });

  await proof.check("a new worktree goes to the project on screen", () => {
    const list = entries();
    assert.deepEqual(
      ids(createTargets([forest, lantern], [], list, lantern.id)),
      [lantern.id, forest.id],
    );
    assert.deepEqual(
      ids(
        createTargets(
          [forest, lantern],
          rankPaletteEntries("wick", list),
          list,
          undefined,
        ),
      ),
      [lantern.id, forest.id],
      "off a project page, the top match's",
    );
    assert.deepEqual(
      ids(createTargets([forest, lantern], [], list, "gone")),
      [forest.id, lantern.id],
      "else the latest work's, never a peer-only one",
    );
  });

  await proof.check("the marked letters are the matched ones", () => {
    assert.deepEqual(matchPositions("st", "fix-stale"), [4, 5]);
    assert.deepEqual(matchPositions("fsl", "fix-stale"), [0, 4, 7]);
    assert.deepEqual(matchPositions("fix st", "fix-stale"), [0, 1, 2, 4, 5]);
    assert.deepEqual(
      matchPositions("lantern fix", "fix/wick"),
      [0, 1, 2],
      "a word of a two-field query",
    );
    assert.equal(matchPositions("zzz", "fix"), null);
    assert.equal(matchPositions("", "fix"), null);
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
