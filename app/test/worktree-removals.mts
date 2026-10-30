// Durable proof for the host's worktree removals (host/lib/Worktrees.ts,
// worktrees/removing.ts) over REAL git repositories, the engine's
// removal and a REAL login shell in each terminal.
//
// Asserts:
//   - a stack's removal takes exactly the worktrees the engine's plan
//     named, each one's scripts stopped before its teardown ran, under
//     the tombstone,
//   - a worktree its script dirtied as it stopped is refused, after the
//     stop and before any teardown,
//   - a refusal at the plan stops nothing and leaves no marks,
//   - deleting a mirrored worktree pauses its mirror before any file
//     goes, then deletes the copy on its device and ends the mirror,
//   - a refused delete, here or of the copy on its device, leaves the
//     mirror running,
//   - a copy whose device is away is deleted once it comes,
//   - a delete from the terminal stops the mirror through the app
//     before its files go, and the copy goes after,
//   - a worktree whose mirror doesn't pause is kept, a copy whose
//     cleanup failed on its device is deleted again, and a copy found
//     gone before its device says both sides went still takes the
//     original,
//   - only a copy's delete of both sides takes the original (not a
//     move's teardown or a nuke's removal there, nor a delete the
//     original's device asked for).
//
// Run: pnpm test worktree-removals.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, it } from "vitest";
import {
  MIRROR_LABEL_MODE,
  type MirrorSessionRaw,
} from "@shigomori/contracts/modules/mirror";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { controlHandlers } from "../host/ipc/modules/control.ts";
import { MirrorError } from "../host/mirror/MirrorEngine.ts";
import { worktreesHandlers } from "../host/ipc/modules/worktrees.ts";
import * as Ops from "../host/lib/engineOps.ts";
import * as HostPushes from "../host/lib/HostPushes.ts";
import { addProject } from "../host/lib/projects/index.ts";
import * as Scripts from "../host/lib/Scripts.ts";
import * as HostWorktrees from "../host/lib/Worktrees.ts";
import {
  endMirrorsIntoGoneCopy,
  endMirrorsOnPeerRemoval,
  MIRROR_LABEL_LOCAL_PROJECT,
  settleMirrorBookkeeping,
} from "../host/mirror/registry.ts";
import type { HandlerContext } from "../shared/ipc/transport.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { standInMirror, standInPeers } from "./lib/hostStandIns.mts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";
import { inertMirrorImpl, rawMirrorSession } from "./lib/mirrorFakes.mts";
import {
  installFakeGh,
  makeTracker,
  sandboxGit,
  scriptEnv,
  scrubProcessGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";
import { pidIn } from "../../test/testProcesses.mts";

// The host's git runs in this process: a commit hook's GIT_* would point
// it at the repository being committed.
scrubProcessGitEnv();
const { track, teardown } = makeTracker();
const git = sandboxGit();
let root: string;

beforeAll(() => {
  initDataDirAt(engineDataDir);
  root = tempDir("sm-removals-", track);
});
afterAll(teardown);

const quiet = {
  notifyPhase: () => {},
  notifyCarryOverComplete: () => {},
  notifyScript: () => {},
};
const here: HandlerContext = {
  notifier: () => () => {},
  connection: new AbortController().signal,
};

// A repo on main, its one commit pushed to a bare origin, registered.
const repoAt = async (name: string) => {
  const repo = join(root, name);
  const origin = join(root, `${name}.git`);
  git(root, "init", "-q", "--bare", origin);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "a");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, project: await runHost(addProject(repo)) };
};

const create = async (
  project: Project,
  input: { worktreeName: string; branchName?: string; base?: string },
): Promise<Worktree> =>
  (
    await runHost(
      Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
        worktrees.create({ projectId: project.id, ...input }, quiet, {
          resolveOn: "exit",
        }),
      ),
    )
  ).worktree;

// A script that records its pid and runs until stopped, the way a dev
// server holds its worktree, running `onStop` in it as it goes.
const runIn = (
  project: Project,
  worktree: Worktree,
  pidFile: string,
  onStop = "",
) =>
  runHost(
    Effect.flatMap(Scripts.Scripts, (scripts) =>
      scripts.start({
        command: `trap '${onStop} exit 0' TERM; echo $$ > '${pidFile}'; while :; do sleep 0.1; done`,
        slot: { kind: "package", name: "serve" },
        worktree: {
          id: worktree.id,
          name: worktree.name,
          branch: worktree.branch,
          path: worktree.path,
        },
        project: { id: project.id, path: project.path, name: project.name },
        scriptEnv,
        notify: () => {},
      }),
    ),
  );

const pr = (number: number, head: string, base: string, state: string) =>
  JSON.stringify({
    number,
    title: head,
    state,
    isDraft: false,
    url: `https://github.com/o/r/pull/${number}`,
    baseRefName: base,
    headRefName: head,
    isCrossRepository: false,
  });

// gh answers from the files the stack below writes: a branch's PRs, the
// project's list (the host's PR map reads it with its own fields, and is
// told bear is still open, so a pick of the host's own takes fox alone),
// a PR's head.
let answers: string;
beforeAll(() => {
  answers = join(root, "gh");
  mkdirSync(answers);
  installFakeGh(
    root,
    `#!/bin/sh
d='${answers}'
case "$*" in
  "--version"*|"auth "*) echo ok;;
  "pr list --state all --head "*) cat "$d/head-$(echo "$*" | sed 's/.*--head \\([^ ]*\\).*/\\1/')";;
  "pr list --state all --limit 200 --json number,url"*) cat "$d/host-list";;
  "pr list --state all --limit 200 "*) cat "$d/list";;
  "pr view "*" --json headRefOid") cat "$d/view-$3";;
  "api --paginate --slurp repos/{owner}/{repo}/stacks"*) echo '[[{"number":4,"pull_requests":[{"number":4},{"number":5}]}]]';;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`,
    track,
  );
});

const marks = async () =>
  (await runHost(Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy)))
    .inflightDeletes;

// A stack in a project of its own: bear (#4) merged into main and fox
// (#5) into bear, each worktree running a script that `onStop` runs in
// as it is stopped, and a teardown that notes in `teardowns` whether
// that script still ran, then runs `teardown` (`$n` its worktree's
// name).
const stackOf = async (
  name: string,
  options: {
    readonly foxState?: string;
    readonly onStop?: { readonly bear?: string };
    readonly teardown?: string;
  } = {},
) => {
  const { project } = await repoAt(name);
  const bear = await create(project, {
    worktreeName: "bear",
    branchName: "bear",
  });
  git(bear.path, "commit", "-q", "--allow-empty", "-m", "bear");
  const fox = await create(project, {
    worktreeName: "fox",
    branchName: "fox",
    base: "bear",
  });
  git(fox.path, "commit", "-q", "--allow-empty", "-m", "fox");
  const foxPr = pr(5, "fox", "bear", options.foxState ?? "MERGED");
  writeFileSync(join(answers, "head-fox"), `[${foxPr}]`);
  writeFileSync(
    join(answers, "head-bear"),
    `[${pr(4, "bear", "main", "MERGED")}]`,
  );
  writeFileSync(
    join(answers, "list"),
    `[${pr(4, "bear", "main", "MERGED")},${foxPr}]`,
  );
  writeFileSync(
    join(answers, "host-list"),
    `[${pr(4, "bear", "main", "OPEN")},${foxPr}]`,
  );
  for (const [number, worktree] of [
    [4, bear],
    [5, fox],
  ] as const) {
    writeFileSync(
      join(answers, `view-${number}`),
      JSON.stringify({
        headRefOid: git(worktree.path, "rev-parse", "HEAD").trim(),
      }),
    );
  }
  const run = join(root, `${name}-run`);
  mkdirSync(run);
  const teardowns = join(run, "teardowns");
  await runHost(
    Ops.writeProjectConfig(project.id, {
      defaultBranch: "main",
      scripts: {
        teardown: `n=$(basename "$PWD"); if kill -0 "$(cat '${run}'/$n.pid)" 2>/dev/null; then echo "$n running"; else echo "$n stopped"; fi >> '${teardowns}'; ${options.teardown ?? "true"}`,
      },
    }),
  );
  await runIn(project, bear, join(run, "bear.pid"), options.onStop?.bear);
  await runIn(project, fox, join(run, "fox.pid"));
  await waitFor(
    () => existsSync(join(run, "bear.pid")) && existsSync(join(run, "fox.pid")),
    "both scripts to start",
  );
  const listed = async () =>
    (await runHost(Ops.listWorktrees(project.id))).map((w) => w.id);
  const ran = () =>
    existsSync(teardowns)
      ? readFileSync(teardowns, "utf8").split("\n").filter(Boolean)
      : [];
  const removeStack = () =>
    worktreesHandlers.deleteStack(
      { projectId: project.id, worktreeId: fox.id },
      here,
    );
  return { project, bear, fox, run, listed, ran, removeStack };
};

it("a stack's removal takes the worktrees its plan named, each stopped under the tombstone", async () => {
  const { bear, fox, listed, ran, removeStack } = await stackOf("taken");
  const result = await runHost(removeStack());
  assert.deepEqual(result, { ok: true, removed: [bear.id, fox.id] });
  assert.deepEqual(ran(), ["bear stopped", "fox stopped"]);
  const left = await listed();
  assert.ok(!left.includes(bear.id) && !left.includes(fox.id), String(left));
  assert.equal(await marks(), 0);
});

it("a worktree its stopping script dirtied is refused before any teardown runs", async () => {
  const { bear, fox, listed, ran, removeStack } = await stackOf("dirtied", {
    onStop: { bear: "touch left-behind.txt;" },
  });
  await assert.rejects(runHost(removeStack()), /bear/);
  assert.ok(existsSync(join(bear.path, "left-behind.txt")));
  assert.deepEqual(ran(), [], "no teardown ran");
  const left = await listed();
  assert.ok(left.includes(bear.id) && left.includes(fox.id), String(left));
  assert.equal(await marks(), 0);
});

it("a refusal at the plan marks nothing and stops nothing", async () => {
  const { bear, run, listed, removeStack } = await stackOf("unplanned", {
    foxState: "OPEN",
  });
  await assert.rejects(runHost(removeStack()), /still open/);
  assert.equal(await marks(), 0);
  const pid = pidIn(readFileSync(join(run, "bear.pid"), "utf8"));
  assert.ok(pid !== undefined, "bear's script wrote no pid");
  assert.doesNotThrow(() => process.kill(pid, 0), "bear's script still runs");
  assert.ok((await listed()).includes(bear.id));
});

// A worktree fox mirrored to a peer's copy, against a recording daemon
// and a peer whose copy's delete `deleteCopy` answers. `calls` says, in
// order, what the mirror was asked and whether fox's folder was still
// there.
const mirroredFox = async (
  name: string,
  deleteCopy: () => Promise<unknown>,
  pauseFails = false,
) => {
  const { project } = await repoAt(name);
  const fox = await create(project, { worktreeName: "fox" });
  const calls: string[] = [];
  const at = () => (existsSync(fox.path) ? "there" : "gone");
  const live = new Map<string, MirrorSessionRaw>([
    [
      name,
      rawMirrorSession({
        session: name,
        deviceId: "peer",
        projectId: "far",
        worktreeId: "copy",
        localRoot: fox.path,
        localWorktreeId: fox.id,
        labels: {
          [MIRROR_LABEL_MODE]: "mirror",
          [MIRROR_LABEL_LOCAL_PROJECT]: project.id,
        },
      }),
    ],
  ]);
  const paused = (id: string, value: boolean) => {
    const raw = live.get(id);
    if (raw !== undefined) live.set(id, { ...raw, paused: value });
  };
  standInMirror(
    inertMirrorImpl({
      status: Effect.succeed("running"),
      sessions: Effect.sync(() => [...live.values()]),
      pause: (id) =>
        pauseFails
          ? Effect.fail(new MirrorError({ reason: "the daemon didn't answer" }))
          : Effect.sync(() => {
              calls.push(`pause ${at()}`);
              paused(id, true);
            }),
      resume: (id) =>
        Effect.sync(() => {
          calls.push("resume");
          paused(id, false);
        }),
      terminate: (id) =>
        Effect.sync(() => {
          calls.push("terminate");
          live.delete(id);
        }),
    }),
  );
  let peer = deleteCopy;
  standInPeers({
    transportFor: () => ({
      invoke: async (channel) => {
        if (channel !== "worktrees:delete") throw new Error("not here");
        calls.push(`delete copy, fox ${at()}`);
        return peer();
      },
      subscribe: () => () => {},
    }),
    channelsFor: () => () => Promise.reject(new Error("not here")),
    admits: () => true,
  });
  const remove = (force: boolean) =>
    runHost(
      worktreesHandlers.delete(
        { projectId: project.id, worktreeId: fox.id, force },
        here,
      ),
    ).then(
      () => "removed",
      () => "refused",
    );
  return {
    project,
    fox,
    calls,
    remove,
    peerAnswers: (next: () => Promise<unknown>) => {
      peer = next;
    },
  };
};

it("deleting a mirrored worktree pauses its mirror first, then deletes the copy", async () => {
  const { fox, calls, remove } = await mirroredFox("mirrored", async () => ({
    ok: true,
  }));
  assert.equal(await remove(false), "removed");
  await waitFor(() => calls.includes("terminate"), "the mirror ended");
  assert.deepEqual(calls, [
    "pause there",
    "delete copy, fox gone",
    "terminate",
  ]);
  assert.ok(!existsSync(fox.path));
});

it("a refused delete of a mirrored worktree leaves its mirror running", async () => {
  const { fox, calls, remove } = await mirroredFox(
    "mirrored-refused",
    async () => ({ ok: true }),
  );
  writeFileSync(join(fox.path, "wip.txt"), "x\n");
  assert.equal(await remove(false), "refused");
  assert.deepEqual(calls, []);
  assert.ok(existsSync(join(fox.path, "wip.txt")));
});

// The copy's device announcing its delete in `state`.
const announced = (state: string, bothSides?: boolean) =>
  runHost(
    endMirrorsOnPeerRemoval("peer", {
      projectId: "far",
      worktreeId: "copy",
      state,
      ...(bothSides === undefined ? {} : { bothSides }),
    }),
  );

it("a mirrored worktree whose mirror doesn't pause is kept", async () => {
  const { fox, calls, remove } = await mirroredFox(
    "mirrored-unpaused",
    async () => ({ ok: true }),
    true,
  );
  assert.equal(await remove(true), "refused");
  assert.deepEqual(calls, []);
  assert.ok(existsSync(fox.path));
});

it("a copy whose cleanup failed on its device is deleted again once the device comes back", async () => {
  const { calls, remove, peerAnswers } = await mirroredFox(
    "mirrored-copy-stayed",
    async () => ({
      ok: false,
      cleanupError: { phase: "teardown", exitCode: 1, runId: "run" },
    }),
  );
  assert.equal(await remove(true), "removed");
  await waitFor(() => calls.length === 2, "the copy's delete was asked");
  peerAnswers(async () => ({ ok: true }));
  await waitFor(async () => {
    await runHost(settleMirrorBookkeeping);
    return calls.includes("terminate");
  }, "the copy was deleted");
  assert.deepEqual(calls, [
    "pause there",
    "delete copy, fox gone",
    "delete copy, fox gone",
    "terminate",
  ]);
});

it("a copy whose delete was refused on its device keeps the original and its mirror", async () => {
  const { fox, calls } = await mirroredFox("mirrored-copy-kept", async () => ({
    ok: true,
  }));
  assert.deepEqual(await announced("removing"), []);
  assert.deepEqual(await announced("kept"), []);
  assert.deepEqual(calls, []);
  assert.ok(existsSync(fox.path));
});

it("a mirrored worktree's copy on a device away is deleted once it comes", async () => {
  const { calls, remove, peerAnswers } = await mirroredFox(
    "mirrored-away",
    () => Promise.reject(new Error("no direct connection to peer")),
  );
  assert.equal(await remove(true), "removed");
  await waitFor(() => calls.length === 2, "the copy's delete was asked");
  assert.deepEqual(calls, ["pause there", "delete copy, fox gone"]);
  peerAnswers(async () => ({ ok: true }));
  // Its look waits until the delete has given up on the copy.
  await waitFor(async () => {
    await runHost(settleMirrorBookkeeping);
    return calls.includes("terminate");
  }, "the copy was deleted");
  assert.deepEqual(calls, [
    "pause there",
    "delete copy, fox gone",
    "delete copy, fox gone",
    "terminate",
  ]);
});

// `sm rm` runs the engine in its own process, which asks the app
// around the files going (packages/cli/src/mirrorsOnDelete.ts).
it("a delete from the terminal stops the mirror through the app first, then deletes the copy", async () => {
  const { project, fox, calls } = await mirroredFox(
    "mirrored-terminal",
    async () => ({ ok: true }),
  );
  const worktree = { projectId: project.id, worktreeId: fox.id };
  await runHost(controlHandlers.stopMirrorForDelete(worktree));
  git(project.path, "worktree", "remove", "--force", fox.path);
  await runHost(controlHandlers.mirrorDeleteDone({ ...worktree, gone: true }));
  await waitFor(() => calls.includes("terminate"), "the mirror ended");
  assert.deepEqual(calls, [
    "pause there",
    "delete copy, fox gone",
    "terminate",
  ]);
});

// The git follower can find the copy gone before its device says so.
it("a copy found gone before its device said both sides went still takes the original", async () => {
  const { project, fox, calls } = await mirroredFox(
    "mirrored-copy-found-gone",
    async () => ({ ok: true }),
  );
  await runHost(endMirrorsIntoGoneCopy("peer", "far", "copy"));
  assert.deepEqual(calls, ["terminate"]);
  assert.deepEqual(await announced("removed", true), [
    { projectId: project.id, worktreeId: fox.id },
  ]);
});

it("only a copy's delete of both sides takes the original", async () => {
  const moved = await mirroredFox("mirrored-copy-moved", async () => ({
    ok: true,
  }));
  assert.deepEqual(await announced("removed"), []);
  assert.deepEqual(moved.calls, ["terminate"]);
  const deleted = await mirroredFox("mirrored-copy-deleted", async () => ({
    ok: true,
  }));
  assert.deepEqual(await announced("removed", true), [
    { projectId: deleted.project.id, worktreeId: deleted.fox.id },
  ]);
  assert.deepEqual(deleted.calls, ["terminate"]);
});

// What a delete's device announces once the delete is over.
const removalAnnounced = (input: {
  projectId: string;
  worktreeId: string;
  oneSide?: boolean;
}) =>
  runHost(
    Effect.scoped(
      Effect.gen(function* () {
        const pushes = yield* (yield* HostPushes.HostPushes).subscribe;
        yield* worktreesHandlers.delete({ ...input, force: true }, here);
        return yield* pushes.pipe(
          Stream.filter(
            ({ channel, payload }) =>
              channel === "worktrees:removal" &&
              (payload as { state: string }).state !== "removing",
          ),
          Stream.map(({ payload }) => payload),
          Stream.runHead,
        );
      }),
    ),
  );

// A mirror's stop, or the original's own delete, asks the copy's device
// to delete the copy: that delete mustn't take the original back.
it("a delete the other device asked for doesn't take that device's side too", async () => {
  const { project } = await repoAt("one-side");
  const asked = await create(project, { worktreeName: "asked" });
  const own = await create(project, { worktreeName: "own" });
  const of = (worktree: Worktree) => ({
    projectId: project.id,
    worktreeId: worktree.id,
  });
  assert.deepEqual(
    await removalAnnounced({ ...of(asked), oneSide: true }),
    Option.some({ ...of(asked), state: "removed" }),
  );
  assert.deepEqual(
    await removalAnnounced(of(own)),
    Option.some({ ...of(own), state: "removed", bothSides: true }),
  );
});
