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
//   - deleting a mirrored worktree pauses its mirror before its cleanup,
//     then ends the mirror and deletes the copy on its device,
//     expecting what that device read of it when the two were in step,
//     its branch at the same commit, whatever git last said,
//   - one not in step with its copy (paused, the copy's device away,
//     the copy's branch at another commit, a file changed on both
//     sides, the copy unread) goes alone, its mirror ended and its copy
//     kept,
//   - a delete refused at its checks leaves the mirror running, and one
//     whose cleanup fails resumes it, so its retry takes both sides,
//   - a copy whose delete fails or is refused on its device stays, and
//     is never asked again,
//   - a delete from the terminal stops the mirror through the app
//     before its cleanup, and the copy goes after, or the mirror goes
//     on when the delete stopped short,
//   - a worktree whose mirror doesn't pause is kept, and a copy found
//     gone before its device says both sides went still takes the
//     original,
//   - only a copy's delete of both sides takes the original (not a
//     move's teardown or a nuke's removal there, nor a delete the
//     original's device asked for, nor an older build's word for both
//     sides), and the original that stays says why on its thread,
//   - an original taken so goes only if it still holds what its device
//     read of it, HEAD on its branch, checked before its scripts stop
//     or its cleanup runs,
//   - a copy's delete of both sides arriving as the peer's push takes
//     the original only with control from other devices on,
//   - a copy's delete takes both sides only of a mirror its peer runs
//     with the files settled before and after the original's device
//     read it and the branch at the same commit on both, and not of a
//     primary's, expecting what that device read of it.
//
// Run: pnpm test worktree-removals.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "../../test/canonicalPaths.mts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { callFailureOf, RemoteCallError } from "@shigomori/contracts/errors";
import type { ChannelEndpoint, ChannelHandle } from "@shigomori/contracts/link";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, it } from "vitest";
import { hubContract } from "@shigomori/contracts/modules/hub";
import {
  MIRROR_LABEL_MODE,
  type MirrorSessionRaw,
} from "@shigomori/contracts/modules/mirror";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { controlHandlers } from "../host/ipc/modules/control.ts";
import { MirrorError } from "../host/mirror/MirrorEngine.ts";
import { worktreesHandlers } from "../host/ipc/modules/worktrees.ts";
import * as Fixtures from "./lib/engineFixtures.mts";
import * as HostAccount from "../host/lib/HostAccount.ts";
import * as HostPushes from "../host/lib/HostPushes.ts";
import { addProject, listWorktrees } from "../host/lib/projects/index.ts";
import * as Scripts from "../host/lib/Scripts.ts";
import * as HostWorktrees from "../host/lib/Worktrees.ts";
import { MirrorLedger } from "../host/mirror/MirrorLedger.ts";
import * as PeerRemovals from "../host/mirror/peerRemovals.ts";
import { annotateMirrorSession } from "../host/mirror/plan.ts";
import { MIRROR_LABEL_LOCAL_PROJECT } from "../host/mirror/registry.ts";
import type { HandlerContext } from "../shared/ipc/transport.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { standInMirror, standInPeers } from "./lib/hostStandIns.mts";
import { engineDataDir, hostContext, runHost } from "./lib/hostRuntime.mts";
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
import {
  pidIn,
  SCRIPT_PID,
  scriptAlive,
} from "../../test/testProcesses.mts";

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
// server holds its worktree, running `onStop` in it as it goes: on its
// way out, which a stop reaches on every OS (Windows sends no SIGTERM).
const runIn = (
  project: Project,
  worktree: Worktree,
  pidFile: string,
  onStop = "",
) =>
  runHost(
    Effect.flatMap(Scripts.Scripts, (scripts) =>
      scripts.start({
        command: `trap '${onStop}' EXIT; echo ${SCRIPT_PID} > '${pidFile}'; while :; do sleep 0.1; done`,
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
    Fixtures.writeProjectConfig(project.id, {
      defaultBranch: "main",
      scripts: {
        teardown: `n=$(basename "$PWD"); if ${scriptAlive(`"$(cat '${run}'/$n.pid)"`)}; then echo "$n running"; else echo "$n stopped"; fi >> '${teardowns}'; ${options.teardown ?? "true"}`,
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
    (await runHost(listWorktrees(project.id))).map((w) => w.id);
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

// What a worktree on the peer holds as its source link answers it: a
// tip, and the tree of a capture when it isn't clean. Null: the link
// fails, as a device that can't read it does.
type Held = { readonly tip: string; readonly tree?: string } | null;

const PEER_TIP = "0123456789abcdef0123456789abcdef01234567";

// The peer's end of sync:openSource's link, answering each ask as
// `held()` says then.
const sourceLink = (held: () => Held) => ({
  open: () =>
    held() === null
      ? Effect.fail(new RemoteCallError({ text: "can't read it" }))
      : Effect.void,
  channels: () => async () => ({
    has: () => true,
    attach: (channelId: string, endpoint: ChannelEndpoint): ChannelHandle => {
      let lines = "";
      const answer = (ask: { ask: string }) => {
        const now = held();
        if (now === null) return { error: "can't read it" };
        if (ask.ask === "tip") return { ok: { commit: now.tip } };
        return {
          ok:
            now.tree === undefined
              ? { captured: false }
              : { captured: true, commit: now.tree, tree: now.tree },
        };
      };
      return {
        channelId,
        open: true,
        write: (data) => {
          lines += Buffer.from(data).toString("utf8");
          for (let end = lines.indexOf("\n"); end !== -1;) {
            const reply = answer(JSON.parse(lines.slice(0, end)));
            lines = lines.slice(end + 1);
            end = lines.indexOf("\n");
            setImmediate(() =>
              endpoint.onData(
                Buffer.from(`${JSON.stringify(reply)}\n`),
                () => {},
              ),
            );
          }
          return true;
        },
        end: () => {},
        reset: () => {},
      };
    },
  }),
});

// What a worktree holds as a delete's expect: its branch at its tip, and
// nothing uncommitted.
const holding = (worktree: Worktree) => ({
  branch: worktree.branch,
  branchTip: git(worktree.path, "rev-parse", "HEAD").trim(),
});

// A worktree fox mirrored to a peer's copy, in step unless `session`
// or `copy` say otherwise, against a recording daemon and a peer whose
// copy holds `copy` (fox's tip by default) and whose copy's delete
// `deleteCopy` answers. Git's last word on the pair is "not checked
// yet", which a delete's look doesn't go by.
// `calls` says, in order, what the mirror was asked and whether fox's
// folder was still there, `deletes` what each delete of the copy
// expected, and `noted` what fox's thread was told.
const mirroredFox = async (
  name: string,
  deleteCopy: () => Promise<unknown>,
  {
    pauseFails = false,
    session = {},
    copy,
  }: {
    readonly pauseFails?: boolean;
    readonly session?: Partial<MirrorSessionRaw>;
    readonly copy?: Held;
  } = {},
) => {
  const { project } = await repoAt(name);
  const fox = await create(project, { worktreeName: "fox" });
  const held = copy === undefined ? { tip: holding(fox).branchTip } : copy;
  const calls: string[] = [];
  const deletes: unknown[] = [];
  const noted: string[] = [];
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
        successfulCycles: 1,
        ...session,
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
      noteEvent: (worktreeId, _, detail) => {
        if (worktreeId === fox.id) noted.push(detail);
      },
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
  const link = sourceLink(() => held);
  standInPeers({
    // Its worktrees list without the copy, which a look then finds gone.
    invoke: (_, channel, input) =>
      channel === "worktrees:list"
        ? Effect.succeed([])
        : channel === "sync:openSource"
          ? link.open()
          : channel !== "worktrees:delete"
            ? Effect.fail(new RemoteCallError({ text: "not here" }))
            : Effect.tryPromise({
                try: () => {
                  calls.push(`delete copy, fox ${at()}`);
                  deletes.push((input as { expect?: unknown }).expect);
                  return deleteCopy();
                },
                catch: callFailureOf,
              }),
    onPush: () => () => {},
    channelsFor: link.channels,
    admits: () => true,
  });
  const remove = (force: boolean, skipCleanup = false) =>
    runHost(
      worktreesHandlers.delete(
        { projectId: project.id, worktreeId: fox.id, force, skipCleanup },
        here,
      ),
    ).then(
      (result) => (result.ok ? "removed" : "kept"),
      () => "refused",
    );
  return { project, fox, calls, deletes, noted, remove };
};

it("deleting a mirrored worktree pauses its mirror first, then deletes the copy expecting what its device read of it", async () => {
  const { fox, calls, deletes, remove } = await mirroredFox(
    "mirrored",
    async () => ({ ok: true }),
  );
  const held = holding(fox);
  assert.equal(await remove(false), "removed");
  await waitFor(() => calls.length === 3, "the copy's delete was asked");
  assert.deepEqual(calls, [
    "pause there",
    "terminate",
    "delete copy, fox gone",
  ]);
  assert.deepEqual(deletes, [held]);
  assert.ok(!existsSync(fox.path));
});

it("a mirrored worktree not in step with its copy goes alone, its mirror ended and its copy kept", async () => {
  const link = rawMirrorSession({ session: "link" }).remote;
  const notInStep: ReadonlyArray<
    readonly [string, Parameters<typeof mirroredFox>[2]]
  > = [
    ["paused", { session: { paused: true } }],
    [
      "away",
      {
        session: {
          status: "connecting-remote",
          remote: { ...link, connected: false },
        },
      },
    ],
    ["elsewhere", { copy: { tip: PEER_TIP } }],
    ["unread", { copy: null }],
    [
      "conflicted",
      {
        session: {
          conflicts: [
            { root: "notes.md", localChanges: [], remoteChanges: [] },
          ],
        },
      },
    ],
  ];
  for (const [why, options] of notInStep) {
    const { fox, calls, remove } = await mirroredFox(
      `not-in-step-${why}`,
      async () => ({ ok: true }),
      options,
    );
    assert.equal(await remove(false), "removed");
    await waitFor(() => calls.includes("terminate"), `the ${why} mirror ended`);
    assert.deepEqual(
      calls,
      why === "paused" ? ["terminate"] : ["pause there", "terminate"],
      why,
    );
    assert.ok(!existsSync(fox.path));
  }
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

// The page then offers the delete again without the cleanup, which
// must still find the mirror to take the copy.
it("a mirrored worktree whose cleanup fails keeps its mirror going, and the delete again takes both sides", async () => {
  const { project, fox, calls, remove } = await mirroredFox(
    "mirrored-cleanup-failed",
    async () => ({ ok: true }),
  );
  await runHost(
    Fixtures.writeProjectConfig(project.id, {
      defaultBranch: "main",
      scripts: { teardown: "exit 1" },
    }),
  );
  assert.equal(await remove(false), "kept");
  assert.deepEqual(calls, ["pause there", "resume"]);
  assert.ok(existsSync(fox.path));
  assert.equal(await remove(true, true), "removed");
  await waitFor(() => calls.length === 5, "the copy's delete was asked");
  assert.deepEqual(calls.slice(2), [
    "pause there",
    "terminate",
    "delete copy, fox gone",
  ]);
});

const settleBookkeeping = Effect.flatMap(
  MirrorLedger,
  (ledger) => ledger.settleMirrorBookkeeping,
);

// The copy's device announcing its delete in `state`, with what else
// it says.
const announced = (state: string, said: object = {}) =>
  runHost(
    Effect.flatMap(MirrorLedger, (ledger) =>
      ledger.endMirrorsOnPeerRemoval("peer", {
        projectId: "far",
        worktreeId: "copy",
        state,
        ...said,
      }),
    ),
  );

const copyHeld = { branch: "fox", branchTip: PEER_TIP };

it("a mirrored worktree whose mirror doesn't pause is kept", async () => {
  const { fox, calls, remove } = await mirroredFox(
    "mirrored-unpaused",
    async () => ({ ok: true }),
    { pauseFails: true },
  );
  assert.equal(await remove(true), "refused");
  assert.deepEqual(calls, []);
  assert.ok(existsSync(fox.path));
});

// The copy's device refuses a copy that changed since the look
// (Worktrees.remove's expect), and nothing asks it again later, so a
// delete can't go through on a copy no look has seen.
it("a copy whose delete fails or is refused on its device stays, never asked again", async () => {
  const failures: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["refused", () => Promise.reject(new Error("fox changed since"))],
    ["away", () => Promise.reject(new Error("no direct connection to peer"))],
    [
      "cleanup-failed",
      async () => ({
        ok: false,
        cleanupError: { phase: "teardown", exitCode: 1, runId: "run" },
      }),
    ],
  ];
  for (const [why, answer] of failures) {
    const { calls, remove } = await mirroredFox(`copy-stays-${why}`, answer);
    assert.equal(await remove(true), "removed");
    await waitFor(() => calls.length === 3, `the ${why} copy's delete`);
    await runHost(settleBookkeeping);
    assert.deepEqual(
      calls,
      ["pause there", "terminate", "delete copy, fox gone"],
      why,
    );
  }
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

// `sm rm` runs the engine in its own process, which asks the app
// around its cleanup and its files going
// (packages/cli/src/mirrorsOnDelete.ts).
it("a delete from the terminal stops the mirror through the app first, then deletes the copy, or goes on when it stopped short", async () => {
  const { project, fox, calls } = await mirroredFox(
    "mirrored-terminal",
    async () => ({ ok: true }),
  );
  const worktree = { projectId: project.id, worktreeId: fox.id };
  await runHost(controlHandlers.stopMirrorForDelete(worktree));
  await runHost(controlHandlers.mirrorDeleteStoppedShort(worktree));
  assert.deepEqual(calls, ["pause there", "resume"]);
  await runHost(controlHandlers.stopMirrorForDelete(worktree));
  git(project.path, "worktree", "remove", "--force", fox.path);
  await runHost(controlHandlers.mirrorDeleteDone({ ...worktree, gone: true }));
  await waitFor(() => calls.length === 5, "the copy's delete was asked");
  assert.deepEqual(calls.slice(2), [
    "pause there",
    "terminate",
    "delete copy, fox gone",
  ]);
});

// The git follower can find the copy gone before its device says so.
it("a copy found gone before its device said both sides went still takes the original", async () => {
  const { project, fox, calls } = await mirroredFox(
    "mirrored-copy-found-gone",
    async () => ({ ok: true }),
  );
  await runHost(
    Effect.flatMap(MirrorLedger, (ledger) =>
      ledger.endMirrorIfCopyGone({
        deviceId: "peer",
        projectId: "far",
        worktreeId: "copy",
      }),
    ),
  );
  assert.deepEqual(calls, ["terminate"]);
  assert.deepEqual(await announced("removed", { expect: copyHeld }), [
    { projectId: project.id, worktreeId: fox.id, expect: copyHeld },
  ]);
});

it("only a copy's delete of both sides takes the original, and one that stays says why", async () => {
  const alone = await mirroredFox("mirrored-copy-alone", async () => ({
    ok: true,
  }));
  assert.deepEqual(await announced("removed"), []);
  assert.deepEqual(alone.calls, ["terminate"]);
  assert.deepEqual(alone.noted, [
    "The copy on the other device was deleted or moved, so the mirror ended. This worktree stays unless the copy was deleted with the two in step.",
  ]);
  // An older build said both sides with no word of what the copy held.
  const older = await mirroredFox("mirrored-copy-older", async () => ({
    ok: true,
  }));
  assert.deepEqual(await announced("removed", { bothSides: true }), []);
  assert.deepEqual(older.calls, ["terminate"]);
  const deleted = await mirroredFox("mirrored-copy-deleted", async () => ({
    ok: true,
  }));
  assert.deepEqual(await announced("removed", { expect: copyHeld }), [
    {
      projectId: deleted.project.id,
      worktreeId: deleted.fox.id,
      expect: copyHeld,
    },
  ]);
  assert.deepEqual(deleted.calls, ["terminate"]);
});

// What the original's device does with a copy's delete of both sides
// (host/mirror/peerRemovals.ts): the original goes only if it still
// holds what its device read of it at the look, so an edit or a branch
// switch since keeps it, with its scripts running and its cleanup
// unrun.
it("an original taken by its copy's delete goes only if it still holds what its device read of it", async () => {
  const { project } = await repoAt("original-taken");
  const fox = await create(project, { worktreeName: "fox" });
  const held = holding(fox);
  const run = join(root, "original-taken-run");
  mkdirSync(run);
  const teardowns = join(run, "teardowns");
  await runHost(
    Fixtures.writeProjectConfig(project.id, {
      defaultBranch: "main",
      scripts: { teardown: `echo ran >> '${teardowns}'` },
    }),
  );
  await runIn(project, fox, join(run, "fox.pid"));
  await waitFor(
    () => existsSync(join(run, "fox.pid")),
    "fox's script to start",
  );
  const pid = pidIn(readFileSync(join(run, "fox.pid"), "utf8"));
  assert.ok(pid !== undefined, "fox's script wrote no pid");
  const untouched = () => {
    assert.doesNotThrow(() => process.kill(pid, 0), "fox's script still runs");
    assert.ok(!existsSync(teardowns), "no teardown ran");
  };
  const take = () =>
    runHost(
      Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
        worktrees.remove(
          {
            projectId: project.id,
            worktreeId: fox.id,
            force: true,
            oneSide: true,
            expect: held,
          },
          () => {},
        ),
      ),
    ).then(
      () => "removed",
      () => "refused",
    );
  writeFileSync(join(fox.path, "since.txt"), "an edit after the look\n");
  assert.equal(await take(), "refused");
  assert.ok(existsSync(join(fox.path, "since.txt")));
  untouched();
  git(fox.path, "add", "since.txt");
  git(fox.path, "commit", "-q", "-m", "since");
  assert.equal(await take(), "refused");
  untouched();
  git(fox.path, "reset", "-q", "--hard", "HEAD~1");
  // Its branch where it was, with HEAD on another holding a commit.
  git(fox.path, "checkout", "-q", "-b", "elsewhere");
  git(fox.path, "commit", "-q", "--allow-empty", "-m", "elsewhere");
  assert.equal(await take(), "refused");
  untouched();
  git(fox.path, "checkout", "-q", fox.branch);
  assert.equal(await take(), "removed");
  assert.ok(!existsSync(fox.path));
});

const MIRROR_ENDED =
  "The copy on the other device was deleted or moved, so the mirror ended. This worktree stays unless the copy was deleted with the two in step.";

// The peer's push of its copy's delete of both sides, expecting what
// fox holds.
const deleted = (fox: Worktree) =>
  runHost(
    HostPushes.push(hubContract, "peerPush", {
      deviceId: "peer",
      channel: "worktrees:removal",
      payload: {
        projectId: "far",
        worktreeId: "copy",
        state: "removed",
        expect: holding(fox),
      },
    }),
  );

// This device signed in with control from other devices `acceptsCommands`,
// or signed out at null.
const setControl = (acceptsCommands: boolean | null) =>
  runHost(
    Effect.flatMap(HostAccount.HostAccount, (account) =>
      account.set(
        acceptsCommands === null
          ? null
          : {
              hubUrl: "http://127.0.0.1:9",
              accountId: "account",
              credential: "",
              deviceKey: "",
              webOrigin: "",
              acceptsCommands,
            },
      ),
    ),
  );

// A copy's delete of both sides as it arrives, a peer's push, which
// takes the original only under the command switch.
it("a copy's delete of both sides takes the original only with control from other devices on", async () => {
  const removals = ManagedRuntime.make(
    PeerRemovals.layer.pipe(
      Layer.provide(Layer.succeedContext(await hostContext())),
    ),
  );
  await removals.context();
  try {
    const off = await mirroredFox("pushed-control-off", async () => ({
      ok: true,
    }));
    await deleted(off.fox);
    await waitFor(
      () => off.noted.length > 1,
      "the original's thread to say why it stays",
    );
    assert.deepEqual(off.calls, ["terminate"]);
    assert.ok(existsSync(off.fox.path));
    assert.deepEqual(off.noted, [
      MIRROR_ENDED,
      "The two were in step when the copy was deleted, but control from other devices is off here, so this worktree stays.",
    ]);

    await setControl(true);
    const on = await mirroredFox("pushed-control-on", async () => ({
      ok: true,
    }));
    await deleted(on.fox);
    await waitFor(
      async () =>
        !(await runHost(listWorktrees(on.project.id))).some(
          (worktree) => worktree.id === on.fox.id,
        ),
      "the original to go",
    );
    assert.ok(!existsSync(on.fox.path));
    assert.deepEqual(on.calls, ["terminate"]);
    assert.deepEqual(on.noted, [MIRROR_ENDED]);
  } finally {
    await setControl(null);
    await removals.dispose();
  }
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
// to delete the copy: that delete mustn't take the original back. The
// copy's own delete takes it only when the peer running the mirror says
// the files are settled, asked while the stream into the copy is up,
// with the branch at the same commit on both, whatever git last said,
// and still settled once its device read it, and only if it still holds
// what its device read of it then. A primary's copy never takes the
// primary.
it("a copy's delete takes both sides only of a mirror in step, expecting what the original's device read, and a delete the other device asked for never does", async () => {
  const { project } = await repoAt("one-side");
  const asked = await create(project, { worktreeName: "asked" });
  const own = await create(project, { worktreeName: "own" });
  // A commit here the original lacks.
  const ahead = await create(project, { worktreeName: "ahead" });
  git(ahead.path, "commit", "-q", "--allow-empty", "-m", "ahead");
  // An edit on the original after its peer's first word that the files
  // are settled, and before its device read it, still crossing.
  const written = await create(project, { worktreeName: "written" });
  const primary = await create(project, { worktreeName: "mirror-main" });
  // A paused mirror's stream is down.
  const paused = await create(project, { worktreeName: "paused" });
  const of = (worktree: Worktree) => ({
    projectId: project.id,
    worktreeId: worktree.id,
  });
  const mirrorInto = (
    worktree: Worktree,
    mode = "mirror",
    fields: Partial<MirrorSessionRaw> = {},
  ) =>
    annotateMirrorSession(
      rawMirrorSession({
        session: `into-${worktree.name}`,
        projectId: project.id,
        worktreeId: worktree.id,
        localWorktreeId: `original-${worktree.name}`,
        labels: {
          [MIRROR_LABEL_MODE]: mode,
          [MIRROR_LABEL_LOCAL_PROJECT]: "far",
        },
        successfulCycles: 1,
        ...fields,
      }),
      { status: "following", detail: "" },
    );
  // The original at the commit every worktree here started from.
  const held = holding(own);
  let reads = 0;
  let writtenAfter = Infinity;
  const link = sourceLink(() => {
    reads += 1;
    return { tip: held.branchTip };
  });
  standInPeers({
    invoke: (_, channel) =>
      channel === "mirror:list"
        ? Effect.sync(() => ({
            daemon: "running",
            sessions: [
              mirrorInto(asked),
              mirrorInto(own),
              mirrorInto(ahead),
              mirrorInto(primary, "mirror-branch"),
              mirrorInto(paused),
              mirrorInto(
                written,
                "mirror",
                reads > writtenAfter ? { status: "staging-local" } : {},
              ),
            ],
            serving: [],
            starting: [],
          }))
        : channel === "sync:openSource"
          ? link.open()
          : Effect.fail(new RemoteCallError({ text: "not here" })),
    onPush: () => () => {},
    channelsFor: link.channels,
  });
  await runHost(
    Effect.map(MirrorLedger, (ledger) => {
      for (const worktree of [asked, own, ahead, primary, written]) {
        const key = `peer:${worktree.name}`;
        ledger.noteServing(
          key,
          {
            channelId: "0".repeat(32),
            ...of(worktree),
            peerDeviceId: "peer",
            peerWorktreeId: `original-${worktree.name}`,
            since: 0,
          },
          () => ledger.forgetServing(key),
        );
      }
    }),
  );
  assert.deepEqual(
    await removalAnnounced({ ...of(asked), oneSide: true }),
    Option.some({ ...of(asked), state: "removed" }),
  );
  assert.deepEqual(
    await removalAnnounced(of(own)),
    Option.some({
      ...of(own),
      state: "removed",
      expect: held,
    }),
  );
  for (const kept of [ahead, primary, paused]) {
    assert.deepEqual(
      await removalAnnounced(of(kept)),
      Option.some({ ...of(kept), state: "removed" }),
      kept.name,
    );
  }
  writtenAfter = reads;
  assert.deepEqual(
    await removalAnnounced(of(written)),
    Option.some({ ...of(written), state: "removed" }),
  );
});
