// Durable proof for the source teardown of a move between devices
// (direct-only): the pull or the send lands the worktree on the other
// device over a REAL DIRECT websocket between the two fixtures,
// brokered by the stub device hub exactly as production does
// (test/lib/directBoot.mts), and the source goes only once the copy
// holds it. The listener registers the REAL sync and worktrees
// contracts and handlers on a real direct listener, and the handlers
// run the REAL engine in-process, which runs REAL git against fixture
// repos. Asserts:
//   - a clean transplant (the pull plus the source's teardown over the
//     peer's grant-gated worktrees:delete) removes the source worktree,
//     its sm data and its branch;
//   - a dirty one lands the capture applied, its index with it, before
//     the still-dirty source is force removed;
//   - a source a script still runs in is refused, and survives;
//   - a teardown with no receipt is refused, and a source that changed
//     after the move, or while its cleanup runs, is kept, for a pull
//     and for a send alike;
//   - a pull cancelled mid-create takes what it made and leaves the
//     source as it was, so the same pull lands after, and a send
//     cancelled on the peer leaves no receipt, so its teardown is
//     refused.
//
// Both "devices" share one node process and one sandboxed
// SHIGOMORI_DATA_DIR holding two projects (source and target repos);
// what separates them is the direct wire between them. Run: pnpm test
// sync-transfer.
import assert from "node:assert/strict";
import * as Schema from "effect/Schema";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  syncContract,
  type SyncMoveRef,
} from "@shigomori/contracts/modules/sync";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { WorktreeSchema } from "@shigomori/contracts/schemas";
import { standInDeviceId, standInPeers } from "./lib/hostStandIns.mts";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { runHost } from "./lib/hostRuntime.mts";
import { worktreeDataHandlers } from "@host/ipc/modules/worktreeData";
import * as Ops from "@host/lib/engineOps";
import * as Scripts from "@host/lib/Scripts";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import {
  handlerCtx,
  makeTracker,
  processAlive,
  scriptEnv,
  waitFor,
} from "./lib/checkKit.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";
import { bootDirectWire, DIALER, LISTENER } from "./lib/directBoot.mts";
import type { ShigomoriConfig } from "@shigomori/contracts/schemas";
import { pidIn } from "../../test/testProcesses.mts";

// The host's engine reads and moves as Promises, on the sandbox's
// engine (runHost).
const readShigomoriConfig = (projectId: string) =>
  runHost(Ops.readProjectConfig(projectId));
const readWorktreeData = (projectId: string, worktreeId: string) =>
  runHost(Ops.readWorktreeData(projectId, worktreeId));
const writeWorktreeData = (...args: Parameters<typeof Ops.writeWorktreeData>) =>
  runHost(Ops.writeWorktreeData(...args));
const writeProjectConfig = (
  ...args: Parameters<typeof Ops.writeProjectConfig>
) => runHost(Ops.writeProjectConfig(...args));
const pullWorktree = (...args: Parameters<typeof syncHandlers.pullWorktree>) =>
  runHost(syncHandlers.pullWorktree(...args));
const sendWorktreeHere = (
  ...args: Parameters<typeof syncHandlers.sendWorktree>
) => runHost(syncHandlers.sendWorktree(...args));
const repoIdentityOf = (path: string) => runHost(Ops.repoIdentity(path));

// The sandbox, the scrubbed process.env with pinned idents, the git
// wrappers, and the engine on the sandbox's data dir
// (test/lib/cliSandbox.mts).
const fixture = cliSandbox("sm-sync-check-");
const { sandbox, git, gitOut, sm } = fixture;
const { commitFile, addWorktree } = fixture;

async function refExists(repo: string, ref: string) {
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

let sourceRepo: string;
let targetRepo: string;
let targetProjectId: string;
let sourceProjectId: string;
let pullCtx: ReturnType<typeof handlerCtx>;
let identity: string;
let wt3Id: string;

const { track, teardown } = makeTracker();

// The transplant as the dialog drives it: the pull, then the
// teardown reading the pull's own receipt.
const transplant = async (
  input: Parameters<typeof syncHandlers.pullWorktree>[0],
) => {
  const pulled = await pullWorktree(input, pullCtx);
  const torn = await runHost(
    syncHandlers.teardownSource(
      {
        direction: "pull",
        deviceId: input.sourceDeviceId,
        projectId: input.sourceProjectId,
        worktreeId: input.sourceWorktreeId,
      },
      pullCtx,
    ),
  );
  return { ...pulled, ...torn };
};

beforeAll(async () => {
  // ---- Fixtures: build the CLI, seed repos, register projects ----
  await fixture.buildSm();

  sourceRepo = await fixture.initRepo("source");
  await git(sourceRepo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  await commitFile(sourceRepo, "readme.txt", "base\n", "base");

  // Target repo: a clone holding only the base history -- the
  // receiving device's copy of the same project.
  targetRepo = await fixture.cloneRepo(sourceRepo, "target");

  await fixture.useCli();
  const { projectIdOf } = fixture;
  // Target first: both fixture projects share one registry AND one repo
  // identity (target is a clone), and the pull handler's identity scan
  // takes the first registry match -- which must be the pull's local
  // target.
  targetProjectId = await projectIdOf(targetRepo);
  sourceProjectId = await projectIdOf(sourceRepo);

  // ---- The direct wire: the listener serves the real sync surface and
  // the real worktrees surface (the transplant's teardown), the dialer
  // reaches it through the real dialer and bridge cache, with the stub
  // device hub carrying ONLY the broker exchange (bootDirectWire, the
  // shared fixture). Teardowns collect on the shared tracker for the
  // afterAll below.
  const { listener, toListener } = await bootDirectWire(track, {
    contracts: [
      [syncContract, syncHandlers],
      [worktreesContract, worktreesHandlers],
    ],
  });
  // The grant every move's calls ride: the listener takes this device's
  // commands.
  listener.setAccepts(true);

  // The peer as the moves reach it. The handlers run HERE as the dialer
  // (the registered surface above is the listener's), with their two
  // real seams injected: the engine (already up) and the peer reach,
  // the direct wire and its channels.
  standInPeers({
    transportFor: (deviceId) => {
      assert.equal(
        deviceId,
        LISTENER,
        "a peer call dialed an unexpected device",
      );
      return {
        ...toListener.transport,
        invoke: async (channel, input, options) => {
          if (channel.startsWith("mirror:")) {
            throw new Error("this proof asks for no mirror");
          }
          // The title's carry. Both devices share the data dir, so the
          // listener's handlers answer in-process.
          if (channel === "worktreeData:read") {
            return runHost(
              worktreeDataHandlers.read(
                input as Parameters<typeof worktreeDataHandlers.read>[0],
              ),
            );
          }
          if (channel === "worktreeData:describe") {
            return runHost(
              worktreeDataHandlers.describe(
                input as Parameters<typeof worktreeDataHandlers.describe>[0],
              ),
            );
          }
          return toListener.transport.invoke(channel, input, options);
        },
      };
    },
    channelsFor: (deviceId) => {
      assert.equal(deviceId, LISTENER, "the move dialed an unexpected device");
      return toListener.channels;
    },
  });
  standInDeviceId(DIALER);
  pullCtx = handlerCtx();
  const repoIdentity = await repoIdentityOf(sourceRepo);
  assert.ok(repoIdentity, "fixture repos should carry a non-null identity");
  identity = repoIdentity;
  assert.equal(
    identity,
    await repoIdentityOf(targetRepo),
    "clone and source must share a repo identity",
  );
});

afterAll(async () => {
  try {
    // Reverse creation order via the shared tracker: the direct
    // sessions and listener first, then the hub connections, then
    // the stub.
    await teardown();
  } finally {
    await fixture.remove();
  }
});

it("transplant (clean): the worktree lands here and the source worktree, its sm data, and its branch are torn down", async () => {
  // ---- The transplant: the pull plus tearing the source worktree
  // down on the listener through its wire-served worktrees:delete,
  // gated by the pull's receipt. A fresh worktree per scenario.

  // (9) Clean transplant: the branch crosses, the worktree lands, and
  // the SOURCE side loses the worktree directory, its sm worktree
  // data, and the branch. A MANAGED worktree (sm create, the realistic
  // transplant source): `sm rm` only deletes the branch for managed
  // worktrees, and the sandbox's unset DeleteBranchOnRemove defaults
  // to delete (Worktrees.remove in the engine).
  const wt3Create = await sm(
    "create",
    "--project-id",
    sourceProjectId,
    "--branch",
    "feature3",
  );
  const wt3Doc = wt3Create.docs.find((doc) => doc.event === "created");
  assert.ok(wt3Doc, "sm create emitted no created doc");
  const wt3 = Schema.decodeUnknownSync(WorktreeSchema)(wt3Doc.worktree);
  const wt3Path = wt3.path;
  wt3Id = wt3.id;
  await commitFile(wt3Path, "third.txt", "third feature\n", "third feature");
  const feature3Tip = await gitOut(wt3Path, "rev-parse", "HEAD");
  // Seed the worktree's own data (the ports the app keeps), so the
  // teardown's sweep of it is observable.
  await writeWorktreeData(sourceProjectId, wt3Id, { ports: [{ port: 4321 }] });
  const cleanTransplant = await transplant({
    sourceDeviceId: LISTENER,
    sourceProjectId,
    sourceWorktreeId: wt3Id,
    sourceIdentity: identity,
    branch: "feature3",
  });
  assert.equal(cleanTransplant.sourceRemoved, true);
  assert.equal(cleanTransplant.sourceError, undefined);
  assert.equal(cleanTransplant.dirtyApplied, false);
  assert.equal(cleanTransplant.worktree.branch, "feature3");
  assert.equal(
    await gitOut(cleanTransplant.worktree.path, "rev-parse", "HEAD"),
    feature3Tip,
  );
  assert.equal(
    await gitOut(cleanTransplant.worktree.path, "status", "--porcelain"),
    "",
    "a clean transplant must land a clean worktree",
  );
  assert.equal(
    existsSync(wt3Path),
    false,
    "the source worktree directory must be gone",
  );
  assert.equal(
    await readWorktreeData(sourceProjectId, wt3Id),
    null,
    "the source sm worktree data must be gone",
  );
  assert.equal(
    await refExists(sourceRepo, "refs/heads/feature3"),
    false,
    "the source branch must be deleted (DeleteBranchOnRemove default)",
  );
});

it("transplant (dirty): the capture lands applied with its index and force removes the still-dirty source worktree", async () => {
  // (10) Dirty transplant: staged + unstaged + untracked dirt on the
  // source. The capture lands here applied, staged and unstaged as
  // they were, and the teardown's captured-driven force removes the
  // (legitimately still dirty) source anyway.
  const wt4Path = await addWorktree(
    sourceRepo,
    "wt4",
    "feature4",
    "committed.txt",
    "committed\n",
    "fourth feature",
  );
  await commitFile(wt4Path, "gone.txt", "gone\n", "a file to delete");
  // Edits the index is told to overlook still move.
  await commitFile(wt4Path, "hidden.txt", "hidden\n", "a file to hide");
  await git(wt4Path, ["update-index", "--assume-unchanged", "hidden.txt"]);
  writeFileSync(join(wt4Path, "hidden.txt"), "hidden, then edited\n");
  await commitFile(wt4Path, "skipped.txt", "skipped\n", "a file to skip");
  await git(wt4Path, ["update-index", "--skip-worktree", "skipped.txt"]);
  writeFileSync(join(wt4Path, "skipped.txt"), "skipped, then edited\n");
  await commitFile(wt4Path, "dropped.txt", "dropped\n", "a file to drop");
  await git(wt4Path, ["update-index", "--assume-unchanged", "dropped.txt"]);
  rmSync(join(wt4Path, "dropped.txt"));
  writeFileSync(join(wt4Path, "staged.txt"), "staged\n");
  await git(wt4Path, ["add", "staged.txt"]);
  writeFileSync(join(wt4Path, "committed.txt"), "committed, then staged\n");
  await git(wt4Path, ["add", "committed.txt"]);
  writeFileSync(join(wt4Path, "committed.txt"), "committed, then edited\n");
  await git(wt4Path, ["mv", "readme.txt", "renamed.txt"]);
  await git(wt4Path, ["rm", "-q", "gone.txt"]);
  writeFileSync(join(wt4Path, "untracked.txt"), "untracked\n");
  const status = await gitOut(wt4Path, "status", "--porcelain");
  assert.match(status, /^R {2}readme\.txt -> renamed\.txt$/m);
  const dirtyTransplant = await transplant({
    sourceDeviceId: LISTENER,
    sourceProjectId,
    sourceWorktreeId: worktreeIdFromPath(wt4Path),
    sourceIdentity: identity,
    branch: "feature4",
  });
  assert.equal(dirtyTransplant.captured, true);
  assert.equal(dirtyTransplant.dirtyApplied, true);
  assert.equal(dirtyTransplant.sourceRemoved, true);
  for (const [file, content] of [
    ["staged.txt", "staged\n"],
    ["committed.txt", "committed, then edited\n"],
    ["hidden.txt", "hidden, then edited\n"],
    ["skipped.txt", "skipped, then edited\n"],
    ["untracked.txt", "untracked\n"],
  ] as const) {
    assert.equal(
      readFileSync(join(dirtyTransplant.worktree.path, file), "utf8"),
      content,
    );
  }
  assert.equal(
    existsSync(join(dirtyTransplant.worktree.path, "dropped.txt")),
    false,
    "the overlooked delete came back",
  );
  // Here the overlooked edits are edits like any other.
  assert.equal(
    (
      await gitOut(dirtyTransplant.worktree.path, "status", "--porcelain")
    ).replace(/^ (M hidden|M skipped|D dropped)\.txt\n/gm, ""),
    status,
  );
  assert.equal(
    existsSync(wt4Path),
    false,
    "the dirty source worktree must be gone (the teardown's force path)",
  );
});

it("transplant (scripts running): the teardown refuses, saying the scripts still run, and the source survives", async () => {
  // (11) Scripts-running refusal: a live script in the source worktree
  // makes the teardown refuse (never kill), so the pull half succeeds
  // and the source survives with the worktree on both sides.
  const wt5Path = await addWorktree(sourceRepo, "wt5", "feature5");
  const wt5Id = worktreeIdFromPath(wt5Path);
  // A REAL long-lived script through the app's registry (the registry
  // is what the refusal flag consults), reaped in the finally below.
  const scripts = await runHost(Scripts.Scripts);
  await runHost(
    scripts.start({
      command: 'node -e "setTimeout(() => {}, 30000)"',
      slot: { kind: "package", name: "sleep" },
      worktree: { id: wt5Id, name: "wt5", branch: "feature5", path: wt5Path },
      project: { id: sourceProjectId, path: sourceRepo, name: "source" },
      scriptEnv,
      notify: () => {},
    }),
  );
  try {
    const refusedTransplant = await transplant({
      sourceDeviceId: LISTENER,
      sourceProjectId,
      sourceWorktreeId: wt5Id,
      sourceIdentity: identity,
      branch: "feature5",
    });
    assert.equal(refusedTransplant.worktree.branch, "feature5");
    assert.equal(
      existsSync(refusedTransplant.worktree.path),
      true,
      "the pull half must still land the worktree here",
    );
    assert.equal(refusedTransplant.sourceRemoved, false);
    assert.match(
      refusedTransplant.sourceError ?? "",
      /^1 script is still running there\.$/,
    );
    assert.equal(
      existsSync(wt5Path),
      true,
      "the source worktree must survive a refused teardown",
    );
    assert.equal(
      scripts.worktrees().some((w) => w.worktreeId === wt5Id),
      true,
      "the refused teardown must leave the source's scripts running",
    );
  } finally {
    await runHost(scripts.stopWorktree(wt5Id));
  }
});

it("teardownSource: refuses without a receipt, refuses a source that changed after the pull, and removes it once it matches again", async () => {
  // (12) The receipt gate: a teardown for a worktree this device never
  // pulled refuses before dialing the peer. A receipt serves exactly
  // one successful teardown. A source that changed after the pull
  // (edits after the capture, or a moved tip) keeps its copy until it
  // matches the receipt again.
  await assert.rejects(
    async () =>
      runHost(
        syncHandlers.teardownSource(
          {
            direction: "pull",
            deviceId: LISTENER,
            projectId: sourceProjectId,
            worktreeId: "0123456789ab",
          },
          pullCtx,
        ),
      ),
    /No pull recorded/,
  );
  await assert.rejects(
    async () =>
      runHost(
        syncHandlers.teardownSource(
          {
            direction: "pull",
            deviceId: LISTENER,
            projectId: sourceProjectId,
            worktreeId: wt3Id,
          },
          pullCtx,
        ),
      ),
    /No pull recorded/,
  );
  const wt6Path = await addWorktree(
    sourceRepo,
    "wt6",
    "feature6",
    "sixth.txt",
    "sixth\n",
    "sixth feature",
  );
  writeFileSync(join(wt6Path, "draft.txt"), "draft\n");
  const wt6Id = worktreeIdFromPath(wt6Path);
  const wt6Source: SyncMoveRef = {
    direction: "pull",
    deviceId: LISTENER,
    projectId: sourceProjectId,
    worktreeId: wt6Id,
  };
  const latePull = await pullWorktree(
    {
      sourceDeviceId: LISTENER,
      sourceProjectId,
      sourceWorktreeId: wt6Id,
      sourceIdentity: identity,
      branch: "feature6",
    },
    pullCtx,
  );
  assert.equal(latePull.captured, true);
  assert.equal(latePull.dirtyApplied, true);
  // The user takes their time. Meanwhile something edits the source.
  writeFileSync(join(wt6Path, "draft.txt"), "draft, then edited\n");
  const refusedLate = await runHost(
    syncHandlers.teardownSource(wt6Source, pullCtx),
  );
  assert.equal(refusedLate.sourceRemoved, false);
  assert.match(refusedLate.sourceError ?? "", /changed after/);
  assert.equal(existsSync(wt6Path), true, "a changed source must survive");
  // Back to exactly the captured state, the receipt matches again.
  writeFileSync(join(wt6Path, "draft.txt"), "draft\n");
  const lateTeardown = await runHost(
    syncHandlers.teardownSource(wt6Source, pullCtx),
  );
  assert.equal(lateTeardown.sourceRemoved, true, lateTeardown.sourceError);
  assert.equal(existsSync(wt6Path), false);
});

it("teardownSource: a source edited while its cleanup runs is kept, the check made again right before the delete", async () => {
  // The receipt matches when the teardown starts. Its teardown script
  // then waits on a gate, and an editor writes to the source meanwhile.
  // A managed worktree: only those run their cleanup.
  const wt8Create = await sm(
    "create",
    "--project-id",
    sourceProjectId,
    "--branch",
    "feature8",
  );
  const wt8Doc = wt8Create.docs.find((doc) => doc.event === "created");
  assert.ok(wt8Doc, "sm create emitted no created doc");
  const wt8 = Schema.decodeUnknownSync(WorktreeSchema)(wt8Doc.worktree);
  const wt8Path = wt8.path;
  const wt8Id = wt8.id;
  await commitFile(wt8Path, "eighth.txt", "eighth\n", "eighth feature");
  writeFileSync(join(wt8Path, "draft.txt"), "draft\n");
  const pulled = await pullWorktree(
    {
      sourceDeviceId: LISTENER,
      sourceProjectId,
      sourceWorktreeId: wt8Id,
      sourceIdentity: identity,
      branch: "feature8",
    },
    pullCtx,
  );
  assert.equal(pulled.dirtyApplied, true);
  const gate = join(sourceRepo, "..", "teardown-gate");
  mkdirSync(gate, { recursive: true });
  const started = join(gate, "started");
  const release = join(gate, "release");
  const before: ShigomoriConfig | null =
    await readShigomoriConfig(sourceProjectId);
  await writeProjectConfig(sourceProjectId, {
    ...before,
    defaultBranch: "main",
    scripts: {
      teardown: `touch '${started}'; while [ ! -e '${release}' ]; do sleep 0.05; done`,
    },
  });
  let torn: Promise<unknown> | undefined;
  try {
    const tearing = runHost(
      syncHandlers.teardownSource(
        {
          direction: "pull",
          deviceId: LISTENER,
          projectId: sourceProjectId,
          worktreeId: wt8Id,
        },
        pullCtx,
      ),
    );
    torn = tearing;
    await waitFor(() => existsSync(started), "the teardown script to start");
    writeFileSync(join(wt8Path, "draft.txt"), "draft, edited meanwhile\n");
    writeFileSync(release, "");
    const result = await tearing;
    assert.equal(result.sourceRemoved, false);
    assert.match(result.sourceError ?? "", /changed after it was moved/);
    assert.equal(
      readFileSync(join(wt8Path, "draft.txt"), "utf8"),
      "draft, edited meanwhile\n",
      "the edit made during the cleanup must survive",
    );
  } finally {
    // Released whatever failed, so no teardown script waits on.
    writeFileSync(release, "");
    await torn?.catch(() => undefined);
    await writeProjectConfig(
      sourceProjectId,
      before ?? { defaultBranch: "main" },
    );
    rmSync(gate, { recursive: true, force: true });
  }
});

it("sendWorktree: a dirty worktree lands on the peer with its commit and its uncommitted work, a repeat is refused by the peer, and the teardown removes the local source only while it still matches what was sent", async () => {
  // ---- The send, the pull turned around: the handler runs HERE as
  // the device holding the source, and the peer lands it (its
  // identity scan takes the target repo, registered first), asking
  // back over the link this side opened. The landing and the local
  // teardown are production code against real git.
  const wt7Path = await addWorktree(
    sourceRepo,
    "wt7",
    "feature7",
    "seventh.txt",
    "seventh\n",
    "seventh feature",
  );
  writeFileSync(join(wt7Path, "draft.txt"), "sent draft\n");
  const wt7 = {
    targetDeviceId: LISTENER,
    projectId: sourceProjectId,
    worktreeId: worktreeIdFromPath(wt7Path),
  };
  const wt7Sent: SyncMoveRef = {
    direction: "send",
    deviceId: LISTENER,
    projectId: sourceProjectId,
    worktreeId: wt7.worktreeId,
  };
  await assert.rejects(
    async () => runHost(syncHandlers.teardownSource(wt7Sent, pullCtx)),
    /No send recorded/,
  );
  const sent = await sendWorktreeHere(wt7, pullCtx);
  assert.equal(sent.captured, true);
  assert.equal(sent.dirtyApplied, true);
  assert.equal(sent.worktree.projectId, targetProjectId);
  assert.equal(sent.worktree.branch, "feature7");
  assert.equal(
    readFileSync(join(sent.worktree.path, "seventh.txt"), "utf8"),
    "seventh\n",
    "the branch's commit landed on the peer",
  );
  assert.equal(
    readFileSync(join(sent.worktree.path, "draft.txt"), "utf8"),
    "sent draft\n",
    "the uncommitted work was re-applied on the peer",
  );
  await assert.rejects(
    () =>
      git(targetRepo, [
        "rev-parse",
        "--verify",
        "-q",
        "refs/shigomori/incoming/feature7",
      ]),
    "the peer's incoming ref must be swept",
  );
  // A second send meets the branch the first one landed, refused by
  // the peer before a byte moves and attributed to it.
  await assert.rejects(
    async () => sendWorktreeHere(wt7, pullCtx),
    /The other device answered: feature7 is already checked out/,
  );
  writeFileSync(join(wt7Path, "draft.txt"), "sent draft, then edited\n");
  const keptSent = await runHost(syncHandlers.teardownSource(wt7Sent, pullCtx));
  assert.equal(keptSent.sourceRemoved, false);
  assert.match(keptSent.sourceError ?? "", /changed after/);
  assert.equal(existsSync(wt7Path), true, "a changed source must survive");
  writeFileSync(join(wt7Path, "draft.txt"), "sent draft\n");
  const tornSent = await runHost(syncHandlers.teardownSource(wt7Sent, pullCtx));
  assert.equal(tornSent.sourceRemoved, true, tornSent.sourceError);
  assert.equal(existsSync(wt7Path), false);
});

// ---- The cancel (sync:cancelMove, host/lib/sync/Moves.ts): a pull
// cut short mid-create, with the target's setup script hung, ends
// within moments with the script dead, the worktree it made
// removed, the branch (kept by `sm rm` under the setting) and
// incoming ref gone and the source untouched. The same for a send,
// where the landing runs on the peer and meets the cancel as the link
// torn down under it, and which leaves no receipt to tear the source
// down on.
describe("cancelMove", () => {
  let targetConfigBefore: ShigomoriConfig | null;
  const setupPidPath = join(sandbox, "setup.pid");
  // The setup script has started: its pid is in the file, and it is
  // the sleep (exec'd, so the pid is the one process to watch).
  const setupPid = () =>
    existsSync(setupPidPath)
      ? pidIn(readFileSync(setupPidPath, "utf8"))
      : undefined;
  const setupStarted = async () => {
    if (existsSync(setupPidPath)) rmSync(setupPidPath);
    await waitFor(
      () => setupPid() !== undefined,
      "the target's setup script to start",
      60_000,
    );
    const pid = setupPid();
    assert.ok(pid !== undefined, "no setup pid");
    return pid;
  };
  const landedNothing = async (branch: string, sourcePath: string) => {
    assert.equal(
      await refExists(targetRepo, `refs/heads/${branch}`),
      false,
      `the cancelled move left ${branch} on the target`,
    );
    assert.equal(
      await refExists(targetRepo, `refs/shigomori/incoming/${branch}`),
      false,
      "the cancelled move left its incoming ref",
    );
    assert.ok(
      !(await gitOut(targetRepo, "worktree", "list", "--porcelain")).includes(
        `branch refs/heads/${branch}`,
      ),
      `the cancelled move left a worktree on ${branch}`,
    );
    assert.equal(existsSync(sourcePath), true, "the source must survive");
  };
  beforeAll(async () => {
    targetConfigBefore = await readShigomoriConfig(targetProjectId);
    await writeProjectConfig(targetProjectId, {
      ...targetConfigBefore,
      defaultBranch: "main",
      scripts: {
        setup: `echo $$ > '${setupPidPath}'; exec sleep 600`,
      },
    });
    // Branches kept on removal, so the rollback has to take the one
    // the move made itself, or a retry would meet it.
    await sm("config", "set", "deleteBranchOnRemove", "false");
  });

  afterAll(async () => {
    await writeProjectConfig(
      targetProjectId,
      targetConfigBefore ?? { defaultBranch: "main" },
    );
    await sm("config", "set", "deleteBranchOnRemove", "true");
  });

  it("cancelMove (pull): the hung setup script dies, the worktree, branch and incoming ref are gone, the source survives, a second cancel finds nothing, and a retry lands", async () => {
    // (a) The pull, cancelled by the caller.
    const wtCancelPath = await addWorktree(sourceRepo, "wt-cancel", "cancel1");
    const wtCancelId = worktreeIdFromPath(wtCancelPath);
    const cancelledPull = Promise.resolve(
      pullWorktree(
        {
          sourceDeviceId: LISTENER,
          sourceProjectId,
          sourceWorktreeId: wtCancelId,
          sourceIdentity: identity,
          branch: "cancel1",
        },
        pullCtx,
      ),
    );
    cancelledPull.catch(() => {});
    const pullSetupPid = await setupStarted();
    assert.equal(processAlive(pullSetupPid), true);
    const cancelledAt = Date.now();
    assert.deepEqual(
      await runHost(
        syncHandlers.cancelMove({ sourceWorktreeId: wtCancelId }, pullCtx),
      ),
      { cancelled: true },
    );
    await assert.rejects(cancelledPull, /The move was cancelled/);
    assert.ok(
      Date.now() - cancelledAt < 20_000,
      "the cancel took longer than the rollback should",
    );
    await waitFor(() => !processAlive(pullSetupPid), "the setup script to die");
    await landedNothing("cancel1", wtCancelPath);
    assert.deepEqual(
      await runHost(
        syncHandlers.cancelMove({ sourceWorktreeId: wtCancelId }, pullCtx),
      ),
      { cancelled: false },
      "a move that is over is not cancellable",
    );
    // And the source is exactly as it was: the same pull lands.
    const retried = await pullWorktree(
      {
        sourceDeviceId: LISTENER,
        sourceProjectId,
        sourceWorktreeId: wtCancelId,
        sourceIdentity: identity,
        branch: "cancel1",
        runSetup: false,
      },
      pullCtx,
    );
    assert.equal(retried.worktree.branch, "cancel1");
  });

  it("cancelMove (send): the peer's landing is cancelled by the link torn down under it, its setup script dies, the copy goes, and no receipt is kept", async () => {
    // (b) The send: the landing runs on the peer, under the link this
    // side tears down as it cancels.
    const wtCancel2Path = await addWorktree(
      sourceRepo,
      "wt-cancel2",
      "cancel2",
    );
    const wtCancel2Id = worktreeIdFromPath(wtCancel2Path);
    const cancelledSend = Promise.resolve(
      sendWorktreeHere(
        {
          targetDeviceId: LISTENER,
          projectId: sourceProjectId,
          worktreeId: wtCancel2Id,
        },
        pullCtx,
      ),
    );
    cancelledSend.catch(() => {});
    const sendSetupPid = await setupStarted();
    assert.deepEqual(
      await runHost(
        syncHandlers.cancelMove({ sourceWorktreeId: wtCancel2Id }, pullCtx),
      ),
      { cancelled: true },
    );
    await assert.rejects(cancelledSend, /The move was cancelled/);
    await waitFor(
      () => !processAlive(sendSetupPid),
      "the peer's setup script to die",
    );
    // The peer unwinds on its own after the link drops: the branch goes
    // with the worktree, and the incoming ref after them.
    await waitFor(
      async () =>
        !(await refExists(targetRepo, "refs/heads/cancel2")) &&
        !(await refExists(targetRepo, "refs/shigomori/incoming/cancel2")),
      "the peer to remove the cancelled copy",
      20_000,
    );
    await landedNothing("cancel2", wtCancel2Path);
    await assert.rejects(
      async () =>
        runHost(
          syncHandlers.teardownSource(
            {
              direction: "send",
              deviceId: LISTENER,
              projectId: sourceProjectId,
              worktreeId: wtCancel2Id,
            },
            pullCtx,
          ),
        ),
      /No send recorded/,
      "a cancelled send must leave no receipt to tear the source down on",
    );
  });
});
