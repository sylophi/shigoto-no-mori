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
//   - a refusal at the plan stops nothing and leaves no marks.
//
// Run: pnpm test worktree-removals.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, it } from "vitest";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { worktreesHandlers } from "../host/ipc/modules/worktrees.ts";
import * as Ops from "../host/lib/engineOps.ts";
import { addProject } from "../host/lib/projects/index.ts";
import * as Scripts from "../host/lib/Scripts.ts";
import * as HostWorktrees from "../host/lib/Worktrees.ts";
import type { HandlerContext } from "../shared/ipc/transport.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";
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
