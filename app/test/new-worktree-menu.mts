// Durable proof for the inbox's New worktree menu
// (renderer/components/sidebar/inbox/createTargets.ts), through the
// very call the menu makes (buildCreateSections).
//
// Asserts: a repo checked out on several devices is one entry, a repo
// only peers hold is one entry however many hold it, the entries file
// under their owners in the tree's order, and an unsplit list (or one
// left with a single owner) has no heading. A project leaves the menu
// when nothing can take its create: missing on disk, or held only by
// peers that can't be commanded.
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test new-worktree-menu.
import assert from "node:assert/strict";
import { projectGroupOrder } from "@/components/sidebar/buildSidebarRows";
import { buildCreateSections } from "@/components/sidebar/inbox/createTargets";
import type { HostApi } from "@/hooks/remote/useHostScope";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { Project } from "@shared/schemas";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("new-worktree-menu proof");
console.log("new-worktree-menu proof\n");

const project = (name: string, owner: string): Project => ({
  id: `id-${name}`,
  name,
  path: `/src/${name}`,
  pathExists: true,
  identity: `repo/${name}`,
  remote: `github.com/${owner}/${name}`,
});

const peerItem = (deviceId: string, of: Project): RemoteForestItem => ({
  deviceId,
  deviceLabel: deviceId,
  deviceIcon: "laptop",
  reachable: true,
  tone: "emerald",
  project: of,
  worktrees: [],
  pullRequests: {},
  showPrimaryInInbox: false,
  worktreesError: false,
});

const forest = project("forest", "acme");
const lantern = project("lantern", "acme");
const kettle = project("kettle", "rin");
const moved = { ...project("moved", "acme"), pathExists: false };
const projects = [forest, lantern, moved];
// forest is here and on both peers, kettle only on the peers.
const remote = [
  peerItem("tp", forest),
  peerItem("mini", forest),
  peerItem("tp", kettle),
  peerItem("mini", kettle),
];

const anyApi = {} as HostApi;
const sections = ({
  byOwner = true,
  commandable = (_deviceId: string) => true,
  local = projects,
  peers = remote,
}: {
  byOwner?: boolean;
  commandable?: (deviceId: string) => boolean;
  local?: Project[];
  peers?: RemoteForestItem[];
} = {}) =>
  buildCreateSections({
    projects: local,
    remote: peers,
    order: projectGroupOrder({
      projects: local,
      remote: peers,
      sortMode: "manual",
      pinned: new Set(),
    }),
    byOwner,
    commandableApi: (deviceId) => (commandable(deviceId) ? anyApi : undefined),
  }).map((section) => [
    section.label,
    section.rows.map((row) => row.project.name),
  ]);

try {
  await proof.check("a repo on several devices is one entry", () => {
    assert.deepEqual(sections(), [
      ["acme", ["forest", "lantern"]],
      ["rin", ["kettle"]],
    ]);
  });

  await proof.check("an unsplit list has no heading", () => {
    assert.deepEqual(sections({ byOwner: false }), [
      [null, ["forest", "lantern", "kettle"]],
    ]);
  });

  await proof.check("peers that can't take a create drop out", () => {
    // kettle is only on the peers, so it goes with them, and the one
    // owner left needs no heading.
    assert.deepEqual(sections({ commandable: () => false }), [
      [null, ["forest", "lantern"]],
    ]);
  });

  await proof.check("one commandable peer keeps a peer-only repo", () => {
    assert.deepEqual(sections({ commandable: (id) => id === "mini" }), [
      ["acme", ["forest", "lantern"]],
      ["rin", ["kettle"]],
    ]);
  });

  await proof.check("a missing local project's peers still list it", () => {
    // forest missing here: its peers' checkouts are a group of their own.
    const missingForest = { ...forest, pathExists: false };
    assert.deepEqual(sections({ local: [missingForest, lantern] }), [
      ["acme", ["lantern", "forest"]],
      ["rin", ["kettle"]],
    ]);
  });

  await proof.check("a peer's checkout missing on disk takes no create", () => {
    const gone = { ...kettle, pathExists: false };
    assert.deepEqual(
      sections({ peers: [peerItem("tp", gone), peerItem("mini", gone)] }),
      [[null, ["forest", "lantern"]]],
    );
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
