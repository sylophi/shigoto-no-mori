// Durable proof for the host's worktree removals (host/lib/Worktrees.ts,
// worktrees/removing.ts) over REAL git repositories, the engine's
// removal and a REAL login shell in each terminal.
//
// Asserts:
//   - a stack's removal takes exactly the worktrees the engine's plan
//     named, each announced as going and then gone, and each one's
//     scripts stopped before its teardown ran, under the tombstone,
//   - a project whose worktrees can't be read for a moment keeps its
//     terminals through the sweep a delete ends with, while the deleted
//     worktree's terminal closes, and the delete's mirror follow-up and
//     its "removed" announcement still happen.
//
// Run: pnpm test worktree-removals.
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, it } from "vitest";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { worktreesHandlers } from "../host/ipc/modules/worktrees.ts";
import * as Ops from "../host/lib/engineOps.ts";
import { addProject } from "../host/lib/projects/index.ts";
import * as Scripts from "../host/lib/Scripts.ts";
import * as Terminals from "../host/lib/terminals/Terminals.ts";
import type { HandlerContext } from "../shared/ipc/transport.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";
import { onHostPush, standInMirror } from "./lib/hostStandIns.mts";
import { inertMirrorImpl } from "./lib/mirrorFakes.mts";
import {
  installFakeGh,
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";

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
      Ops.createWorktree(project, input, quiet, { resolveOn: "exit" }),
    )
  ).worktree;

// A script that records its pid and sleeps, the way a dev server holds
// its worktree.
const runIn = (project: Project, worktree: Worktree, pidFile: string) =>
  runHost(
    Effect.flatMap(Scripts.Scripts, (scripts) =>
      scripts.start({
        command: `echo $$ > '${pidFile}'; exec sleep 30`,
        slot: { kind: "package", name: "serve" },
        worktree: {
          id: worktree.id,
          name: worktree.name,
          branch: worktree.branch,
          path: worktree.path,
        },
        project: { id: project.id, path: project.path, name: project.name },
        scriptEnv: {
          projectBranch: "main",
          defaultBranch: "main",
          title: "",
          description: "",
        },
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

it("a stack's removal takes the worktrees its plan named, each stopped under the tombstone", async () => {
  const { repo, project } = await repoAt("stack");
  // bear (#4) merged into main, fox (#5) merged into bear.
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
  // The engine's reads are its own (`--json number,title,...`), the
  // host's PR map's another (`--json number,url,...`), which still
  // has bear open.
  const both = `[${pr(4, "bear", "main", "MERGED")},${pr(5, "fox", "bear", "MERGED")}]`;
  installFakeGh(
    root,
    `#!/bin/sh
case "$*" in
  "--version"*|"auth "*) echo ok;;
  "pr list --state all --head fox "*) echo '[${pr(5, "fox", "bear", "MERGED")}]';;
  "pr list --state all --head bear "*) echo '[${pr(4, "bear", "main", "MERGED")}]';;
  "pr list --state all --limit 200 --json number,title"*) echo '${both}';;
  "pr list --state all --limit 200 --json number,url"*) echo '[${pr(4, "bear", "main", "OPEN")},${pr(5, "fox", "bear", "MERGED")}]';;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`,
    track,
  );
  // Each teardown says whether its worktree's script still ran.
  const verdicts = join(root, "teardowns");
  await runHost(
    Ops.writeProjectConfig(project.id, {
      defaultBranch: "main",
      scripts: {
        teardown: `n=$(basename "$PWD"); if kill -0 "$(cat '${root}'/$n.pid)" 2>/dev/null; then echo "$n running"; else echo "$n stopped"; fi >> '${verdicts}'`,
      },
    }),
  );
  for (const worktree of [bear, fox]) {
    await runIn(project, worktree, join(root, `${worktree.name}.pid`));
  }
  await waitFor(
    () =>
      existsSync(join(root, "bear.pid")) && existsSync(join(root, "fox.pid")),
    "both scripts to start",
  );
  announced.length = 0;
  const result = await runHost(
    worktreesHandlers.deleteStack(
      { projectId: project.id, worktreeId: fox.id, force: true },
      here,
    ),
  );
  assert.deepEqual(result, { ok: true, removed: [bear.id, fox.id] });
  assert.deepEqual(readFileSync(verdicts, "utf8").split("\n").filter(Boolean), [
    "bear stopped",
    "fox stopped",
  ]);
  assert.deepEqual(announced, [
    `${bear.id} removing`,
    `${fox.id} removing`,
    `${bear.id} removed`,
    `${fox.id} removed`,
  ]);
  const left = (await runHost(Ops.listWorktrees(project.id))).map((w) => w.id);
  assert.ok(!left.includes(bear.id) && !left.includes(fox.id), String(left));
  assert.ok(existsSync(repo));
});

// A terminal of the worktree's, and the ones open.
const open = (project: Project, worktree: Worktree) =>
  runHost(
    Effect.flatMap(Terminals.Terminals, (terminals) =>
      terminals.open({
        owner: {
          kind: "worktree",
          projectId: project.id,
          worktreeId: worktree.id,
        },
      }),
    ),
  );
const openIds = async () =>
  Option.getOrElse(
    await runHost(
      Effect.flatMap(Terminals.Terminals, (terminals) =>
        Stream.runHead(terminals.list),
      ),
    ),
    () => [],
  ).map((terminal) => terminal.terminalId);

it("a project unreadable for a moment keeps its terminals through a delete's sweep, and the delete still finishes", async () => {
  const kept = await repoAt("kept");
  const gone = await repoAt("gone");
  const owl = await create(kept.project, { worktreeName: "owl" });
  const fox = await create(gone.project, { worktreeName: "fox" });
  const forgot: string[] = [];
  standInMirror(
    inertMirrorImpl({ forgetHistory: (id) => void forgot.push(id) }),
  );
  // The unreadable project's terminal first, so a sweep that died on it
  // would never reach the other.
  const owlTerminal = await open(kept.project, owl);
  const foxTerminal = await open(gone.project, fox);
  // git refuses every read of the repo while its config is broken, and
  // the engine lists none of its worktrees.
  const config = join(kept.repo, ".git", "config");
  const intact = readFileSync(config, "utf8");
  appendFileSync(config, "[broken\n");
  track(() => writeFileSync(config, intact));
  announced.length = 0;
  try {
    const result = await runHost(
      worktreesHandlers.delete(
        { projectId: gone.project.id, worktreeId: fox.id, force: true },
        here,
      ),
    );
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(announced, [`${fox.id} removing`, `${fox.id} removed`]);
    assert.deepEqual(forgot, [fox.id], "the deleted worktree's mirrors went");
    const left = await openIds();
    assert.ok(left.includes(owlTerminal.terminalId), "the unread one stays");
    assert.ok(!left.includes(foxTerminal.terminalId), "the gone one closed");
  } finally {
    writeFileSync(config, intact);
    standInMirror(inertMirrorImpl());
    await runHost(
      Effect.flatMap(Terminals.Terminals, (terminals) =>
        terminals.close(owlTerminal.terminalId).pipe(Effect.ignore),
      ),
    );
  }
});
