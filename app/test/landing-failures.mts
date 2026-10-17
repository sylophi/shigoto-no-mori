// Durable proof for a landing that fails after its create
// (host/lib/sync/landing.ts, Worktrees.createHeld in
// host/lib/worktrees/creating.ts), over a REAL git repository and the
// engine's create and removal. The source is this device's own repo,
// answering as a peer's link would; the failures are injected into the
// landing's own git steps.
//
// Asserts:
//   - a failure at the capture's tree (before the create), at its ref's
//     write (right after the create) and at the source ref's delete
//     (after that write) each leaves no worktree, no folder and no
//     branch, and the same landing then lands, its capture applied,
//   - the copy's undo runs under the tombstone: announced as going and
//     gone, counted as a removal, a delete of it meanwhile refused,
//   - an undo whose teardown script fails still removes the copy,
//   - the landing's hold of the data-folder lock is counted as a change
//     between its create and its last ref step.
//
// Run: pnpm test landing-failures.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, it } from "vitest";
import type { Project } from "@shigomori/contracts/schemas";
import * as Git from "@shigomori/engine/Git";
import { dirtyRef } from "@shigomori/engine/Dirty";
import * as Ops from "../host/lib/engineOps.ts";
import { addProject } from "../host/lib/projects/index.ts";
import * as Scripts from "../host/lib/Scripts.ts";
import { landWorktree } from "../host/lib/sync/landing.ts";
import type { WorktreeSource } from "../host/lib/sync/sourceLink.ts";
import * as HostWorktrees from "../host/lib/Worktrees.ts";
import type { HandlerContext } from "../shared/ipc/transport.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";
import { onHostPush } from "./lib/hostStandIns.mts";
import {
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";

scrubProcessGitEnv();
const { track, teardown } = makeTracker();
const git = sandboxGit();
let root: string;
let repo: string;
let project: Project;
let identity: string;
let tip: string;
let capture: { commit: string; tree: string };
const SOURCE_WORKTREE = "0123456789ab";

beforeAll(async () => {
  initDataDirAt(engineDataDir);
  root = tempDir("sm-landing-failures-", track);
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "a");
  project = await runHost(addProject(repo));
  identity = (await runHost(Ops.repoIdentity(repo))) ?? "";
  // The source's branch tip, a commit this repo holds under no branch,
  // and its capture: the tip with an uncommitted file.
  tip = git(
    repo,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "tip",
  ).trim();
  writeFileSync(join(root, "dirty.txt"), "uncommitted\n");
  const blob = git(repo, "hash-object", "-w", join(root, "dirty.txt")).trim();
  git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},dirty.txt`);
  const tree = git(repo, "write-tree").trim();
  git(repo, "read-tree", "HEAD");
  capture = {
    commit: git(repo, "commit-tree", tree, "-p", tip, "-m", "capture").trim(),
    tree,
  };
});
afterAll(teardown);

// The source as a link answers it: the tip, the capture, and a fetch
// that lands the capture under refs/shigomori/ (the tip is local).
const source: WorktreeSource = {
  tip: () => Effect.succeed(tip),
  capture: Effect.sync(() => ({ captured: true, ...capture })),
  cloneFacts: Effect.die("no clone here"),
  fetch: ({ refs }) =>
    Effect.sync(() => {
      for (const ref of refs) git(repo, "update-ref", ref, capture.commit);
      return { fetched: refs.map((ref) => ({ ref, commit: capture.commit })) };
    }),
  report: () => {},
};

const here: HandlerContext = {
  notifier: () => () => {},
  connection: new AbortController().signal,
};

// The landing's git, `before` run ahead of the step it names (the
// capture's tree, the capture's ref written under the copy's id, the
// source's deleted).
type Step = "tree" | "ref" | "sourceRef";
const injected = (before: (step: Step) => Effect.Effect<void, Git.GitError>) =>
  Effect.map(Git.Git, (real) =>
    Git.Git.of({
      ...real,
      treeOf: (cwd, commit) =>
        commit === capture.commit
          ? Effect.andThen(before("tree"), real.treeOf(cwd, commit))
          : real.treeOf(cwd, commit),
      updateRef: (input) =>
        input.ref.startsWith("refs/shigomori/dirty/") &&
        input.ref !== dirtyRef(SOURCE_WORKTREE)
          ? Effect.andThen(before("ref"), real.updateRef(input))
          : real.updateRef(input),
      deleteRef: (cwdRepo, ref, expected) =>
        ref === dirtyRef(SOURCE_WORKTREE)
          ? Effect.andThen(before("sourceRef"), real.deleteRef(cwdRepo, ref))
          : real.deleteRef(cwdRepo, ref, expected),
    }),
  );

const failAt = (at: Step) => (step: Step) =>
  step === at
    ? Effect.fail(
        new Git.GitCommandError({
          subcommand: "update-ref",
          exitCode: 128,
          cause: "injected",
        }),
      )
    : Effect.void;

const land = (
  name: string,
  before: (step: Step) => Effect.Effect<void, Git.GitError> = () => Effect.void,
) =>
  runHost(
    Effect.flatMap(injected(before), (stood) =>
      Effect.scoped(
        Effect.flatMap(Effect.scope, (move) =>
          landWorktree(
            source,
            {
              identity,
              branch: name,
              landBranch: name,
              worktreeName: name,
              runSetup: false,
              sourceWorktreeId: SOURCE_WORKTREE,
            },
            here,
            () => {},
            move,
          ),
        ),
      ).pipe(Effect.provideService(Git.Git, stood)),
    ),
  );

const branches = () =>
  git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

const leftNothing = async (name: string) => {
  assert.ok(!branches().includes(name), `the failed landing left ${name}`);
  const listed = await runHost(
    Ops.listWorktreeIdentities({ projectId: project.id }),
  );
  assert.deepEqual(
    listed.filter((w) => w.name === name),
    [],
    `the failed landing left a worktree named ${name}`,
  );
  const { path } = await runHost(Ops.worktreeDestination(project.id, name));
  assert.ok(!existsSync(path), `the failed landing left ${path}`);
};

const landsAfter = async (name: string) => {
  const landed = await land(name);
  assert.equal(landed.worktree.branch, name);
  assert.equal(landed.dirtyApplied, true);
  assert.ok(existsSync(join(landed.worktree.path, "dirty.txt")));
};

// Every removal announcement from here on, as `<worktree id> <state>`.
const announced: string[] = [];
onHostPush((push) => {
  if (push.channel !== "worktrees:removal") return;
  const { worktreeId, state } = push.payload as {
    worktreeId: string;
    state: string;
  };
  announced.push(`${worktreeId} ${state}`);
});

for (const [step, name] of [
  ["tree", "otter"],
  ["ref", "heron"],
  ["sourceRef", "wren"],
] as const) {
  it(`a failure at the ${step} step leaves no copy, and the landing lands after`, async () => {
    await assert.rejects(land(name, failAt(step)), /git update-ref/);
    await leftNothing(name);
    await landsAfter(name);
  });
}

it("the undo of a copy runs under the tombstone, and a teardown that fails still takes it", async () => {
  const held = join(root, "teardown.held");
  const holding = join(root, "teardown.holding");
  writeFileSync(held, "");
  await runHost(
    Ops.writeProjectConfig(project.id, {
      defaultBranch: "main",
      scripts: {
        teardown: `touch '${holding}'; while [ -f '${held}' ]; do sleep 0.05; done; exit 1`,
      },
    }),
  );
  announced.length = 0;
  const failing = land("kite", failAt("ref"));
  failing.catch(() => {});
  try {
    await waitFor(() => existsSync(holding), "the copy's teardown", 30_000);
    const [copyId, state] = (announced[0] ?? "").split(" ");
    assert.equal(state, "removing", "the undo is announced");
    assert.equal(
      (
        await runHost(
          Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy),
        )
      ).inflightDeletes,
      1,
    );
    await assert.rejects(
      runHost(
        Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
          worktrees.remove(
            { projectId: project.id, worktreeId: copyId ?? "" },
            () => {},
          ),
        ),
      ),
      /already being removed/,
    );
  } finally {
    rmSync(held);
  }
  await assert.rejects(failing, /git update-ref/);
  assert.deepEqual(
    announced.map((entry) => entry.split(" ")[1]),
    ["removing", "removed"],
  );
  await leftNothing("kite");
  await runHost(Ops.writeProjectConfig(project.id, { defaultBranch: "main" }));
  await landsAfter("kite");
});

it("the landing counts as a change between its create and its last ref step", async () => {
  const atRef = await runHost(Deferred.make<void>());
  const release = await runHost(Deferred.make<void>());
  const landing = land("lark", (step) =>
    step === "sourceRef"
      ? Deferred.succeed(atRef, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        )
      : Effect.void,
  );
  try {
    await runHost(Deferred.await(atRef));
    assert.equal(
      (
        await runHost(
          Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy),
        )
      ).engineChanges,
      1,
    );
  } finally {
    await runHost(Deferred.succeed(release, undefined));
  }
  assert.equal((await landing).worktree.branch, "lark");
  assert.equal(
    (await runHost(Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy)))
      .engineChanges,
    0,
  );
});
