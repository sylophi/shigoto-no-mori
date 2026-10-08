// Durable proof for the Agent working shelf: with agents allowed to
// mark worktrees as working, a worktree an agent marked (`sm
// agent-working`) files on its own fold (groupShelfOf, which the
// inbox's buildInboxRows files by too, and the tree's buildSidebarRows),
// folded until opened and ahead of the other folds, and the mark
// outranks being shelved or hidden. Cleared, or with agents not allowed
// to, the worktree is back with the live work.
// (buildInboxRows itself imports hooks this loader can't run.)
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test agent-working-shelf.
import assert from "node:assert/strict";
import {
  buildSidebarRows,
  groupShelfOf,
  projectGroupKey,
  projectGroupOrder,
} from "@/components/sidebar/buildSidebarRows";
import type { SidebarRow } from "@/components/sidebar/sidebarRow";
import type { Project, Worktree } from "@shared/schemas";
import { worktree as fakeWorktree } from "../lab/fake-host/fixtures.ts";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("agent-working-shelf proof");
console.log("agent-working-shelf proof\n");

const project: Project = {
  id: "id-lichen",
  name: "lichen",
  path: "/src/lichen",
  pathExists: true,
  identity: "repo/lichen",
};

const worktree = (name: string, marks: Partial<Worktree> = {}): Worktree =>
  fakeWorktree({
    id: `lichen-${name}`,
    projectId: project.id,
    name,
    branch: name,
    path: `/src/lichen-${name}`,
    ...marks,
  });

const forest = (marked: boolean) => [
  worktree("main", { isPrimary: true }),
  worktree("live"),
  worktree("agent", { agentWorking: marked, lastChangeAt: 500 }),
  worktree("agent-shelved", { agentWorking: true, shelved: true }),
  worktree("exp/agent", { agentWorking: true }),
  worktree("old", { shelved: true }),
];

const rows = (trees: Worktree[], allowAgentWorking: boolean, open: boolean) =>
  buildSidebarRows({
    projects: [project],
    worktreeQueries: [
      { data: trees, isLoading: false, isPending: false, error: null },
    ],
    pullRequestQueries: [
      { data: {}, isLoading: false, isPending: false, error: null },
    ],
    openKey: projectGroupKey(project, undefined),
    order: projectGroupOrder({
      projects: [project],
      remote: [],
      sortMode: "manual",
      pinned: new Set(),
    }),
    worktreeSort: "name",
    openShelves: {
      agentWorking: { has: () => open },
      shelved: { has: () => false },
      hidden: { has: () => false },
    },
    hiddenPrefixes: ["exp/"],
    allowAgentWorking,
    byPrefix: null,
    arrangeMode: false,
    byOwner: null,
    remote: [],
    mirrors: [],
    deviceBadges: new Map(),
  })
    .rows.filter((row) => row.kind !== "project")
    .map(line);

const line = (row: SidebarRow) => {
  if (row.kind === "shelved-toggle") {
    return `${row.expanded ? "v" : ">"} ${row.shelf} ${row.count}`;
  }
  if ("worktree" in row) return row.worktree.name;
  return row.kind;
};

try {
  await proof.check("the mark outranks the other folds", () => {
    const shelf = (marks: Partial<Worktree>, name = "a") =>
      groupShelfOf(worktree(name, marks), ["exp/"], true);
    assert.equal(shelf({ agentWorking: true }), "agentWorking");
    assert.equal(shelf({ agentWorking: true, shelved: true }), "agentWorking");
    assert.equal(shelf({ agentWorking: true }, "exp/a"), "agentWorking");
    assert.equal(shelf({}), null);
  });

  await proof.check("the tree: an Agent working fold ahead of Shelved", () => {
    assert.deepEqual(rows(forest(true), true, false), [
      "main",
      "live",
      "> agentWorking 3",
      "> shelved 1",
    ]);
    assert.deepEqual(rows(forest(true), true, true), [
      "main",
      "live",
      "agent",
      "agent-shelved",
      "exp/agent",
      "v agentWorking 3",
      "> shelved 1",
    ]);
  });

  await proof.check("cleared, it's live again", () => {
    assert.deepEqual(rows(forest(false), true, false), [
      "main",
      "agent",
      "live",
      "> agentWorking 2",
      "> shelved 1",
    ]);
  });

  await proof.check("with agents not allowed to, the mark is ignored", () => {
    assert.equal(
      groupShelfOf(worktree("a", { agentWorking: true }), [], false),
      null,
    );
    // The others fall back to where they'd be without it.
    assert.deepEqual(rows(forest(true), false, false), [
      "main",
      "agent",
      "live",
      "> shelved 2",
      "> hidden 1",
    ]);
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
