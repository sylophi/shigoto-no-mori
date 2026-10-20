// Durable proof for the host's worktree removals (host/lib/Worktrees.ts,
// worktrees/removing.ts) over REAL git repositories, the engine's
// removal and a REAL login shell in each terminal.
//
// Asserts:
//   - a stack's removal takes exactly the worktrees the engine's plan
//     named, each announced as going and then gone, and each one's
//     scripts stopped before its teardown ran, under the tombstone,
//   - a worktree its script dirtied as it stopped is refused, after the
//     stop and before any teardown,
//   - a refusal at the plan announces nothing and leaves no marks; a
//     removal cut short by an interrupt, or failing partway, announces
//     each planned worktree removed or kept as it is, and clears the
//     marks,
//   - a project whose worktrees can't be read for a moment keeps its
//     terminals through the sweep a delete ends with, while the deleted
//     worktree's terminal closes, and the delete's mirror follow-up and
//     its "removed" announcement still happen,
//   - a project gone takes its scripts and terminals, whether the app
//     removed it or a terminal's `sm projects remove` did; a terrier
//     project missing from a listing terrier failed is not gone, and a
//     run started while the reap reads the list stays; the store's
//     sweep makes no quit ask.
//
// Run: pnpm test worktree-removals.
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, it } from "vitest";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { projectsHandlers } from "../host/ipc/modules/projects.ts";
import { worktreesHandlers } from "../host/ipc/modules/worktrees.ts";
import * as Ops from "../host/lib/engineOps.ts";
import { addProject, freshProjects } from "../host/lib/projects/index.ts";
import * as Scripts from "../host/lib/Scripts.ts";
import * as HostWorktrees from "../host/lib/Worktrees.ts";
import * as Terminals from "../host/lib/terminals/Terminals.ts";
import * as Terrier from "@shigomori/engine/Terrier";
import type { HandlerContext } from "../shared/ipc/transport.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { engineDataDir, hostContext, runHost } from "./lib/hostRuntime.mts";
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
import { pidIn } from "../../testProcesses.mts";

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
  announced.length = 0;
  return { project, bear, fox, run, listed, ran, removeStack };
};

it("a stack's removal takes the worktrees its plan named, each stopped under the tombstone", async () => {
  const { bear, fox, listed, ran, removeStack } = await stackOf("taken");
  const result = await runHost(removeStack());
  assert.deepEqual(result, { ok: true, removed: [bear.id, fox.id] });
  assert.deepEqual(ran(), ["bear stopped", "fox stopped"]);
  assert.deepEqual(announced, [
    `${bear.id} removing`,
    `${fox.id} removing`,
    `${bear.id} removed`,
    `${fox.id} removed`,
  ]);
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
  assert.deepEqual(announced, [
    `${bear.id} removing`,
    `${fox.id} removing`,
    `${bear.id} kept`,
    `${fox.id} kept`,
  ]);
  const left = await listed();
  assert.ok(left.includes(bear.id) && left.includes(fox.id), String(left));
  assert.equal(await marks(), 0);
});

it("a refusal at the plan announces nothing, marks nothing and stops nothing", async () => {
  const { bear, run, listed, removeStack } = await stackOf("unplanned", {
    foxState: "OPEN",
  });
  await assert.rejects(runHost(removeStack()), /still open/);
  assert.deepEqual(announced, []);
  assert.equal(await marks(), 0);
  const pid = pidIn(readFileSync(join(run, "bear.pid"), "utf8"));
  assert.ok(pid !== undefined, "bear's script wrote no pid");
  assert.doesNotThrow(() => process.kill(pid, 0), "bear's script still runs");
  assert.ok((await listed()).includes(bear.id));
});

it("a removal that fails partway announces what went and what stayed", async () => {
  const { bear, fox, listed, ran, removeStack } = await stackOf("partial", {
    teardown: `[ "$n" != fox ]`,
  });
  const result = await runHost(removeStack());
  assert.equal(result.ok, false);
  assert.deepEqual(result.removed, [bear.id]);
  assert.deepEqual(ran(), ["bear stopped", "fox stopped"]);
  assert.deepEqual(announced, [
    `${bear.id} removing`,
    `${fox.id} removing`,
    `${bear.id} removed`,
    `${fox.id} kept`,
  ]);
  const left = await listed();
  assert.ok(!left.includes(bear.id) && left.includes(fox.id), String(left));
  assert.equal(await marks(), 0);
});

// Cuts the stack's removal in while `blocked`'s teardown runs: the
// teardown waits for a `go` file, and the release half a second after
// the interrupt keeps the test from hanging if the interrupt waits for
// the teardown.
const interruptDuring = async (name: string, blocked: "bear" | "fox") => {
  const go = join(root, `${name}-run`, "go");
  const stack = await stackOf(name, {
    teardown: `if [ "$n" = ${blocked} ]; then while [ ! -f '${go}' ]; do sleep 0.05; done; fi`,
  });
  const fiber = Effect.runForkWith(await hostContext())(stack.removeStack());
  await waitFor(
    () => stack.ran().at(-1) === `${blocked} stopped`,
    `${blocked}'s teardown to start`,
  );
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
  setTimeout(() => writeFileSync(go, ""), 500);
  await interrupted;
  return stack;
};

it("an interrupt before anything went announces every planned worktree kept and clears the marks", async () => {
  const { bear, fox, listed, ran } = await interruptDuring("cut", "bear");
  assert.deepEqual(ran(), ["bear stopped"]);
  assert.deepEqual(announced, [
    `${bear.id} removing`,
    `${fox.id} removing`,
    `${bear.id} kept`,
    `${fox.id} kept`,
  ]);
  const left = await listed();
  assert.ok(left.includes(bear.id) && left.includes(fox.id), String(left));
  assert.equal(await marks(), 0);
});

it("an interrupt after one layer went announces it removed and the rest kept", async () => {
  const { bear, fox, listed, ran } = await interruptDuring("cut-later", "fox");
  assert.deepEqual(ran(), ["bear stopped", "fox stopped"]);
  assert.deepEqual(announced, [
    `${bear.id} removing`,
    `${fox.id} removing`,
    `${bear.id} removed`,
    `${fox.id} kept`,
  ]);
  const left = await listed();
  assert.ok(!left.includes(bear.id) && left.includes(fox.id), String(left));
  assert.equal(await marks(), 0);
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

const running = (worktree: Worktree) =>
  runHost(
    Effect.map(Scripts.Scripts, (scripts) => scripts.runningIn(worktree.id)),
  );

it("a project gone takes its scripts and terminals, removed in the app or from a terminal", async () => {
  for (const [name, remove] of [
    // `sm projects remove` in a terminal: the engine's removal alone,
    // which the store's change tells the app of.
    [
      "left-terminal",
      (project: Project) =>
        runHost(
          Effect.andThen(
            Ops.removeProject(project.id),
            Effect.flatMap(
              Scripts.Scripts,
              (scripts) => scripts.reapRemovedProjects,
            ),
          ),
        ),
    ],
    [
      "left-app",
      (project: Project) =>
        runHost(projectsHandlers.remove({ id: project.id })),
    ],
  ] as const) {
    const { project } = await repoAt(name);
    const lynx = await create(project, { worktreeName: "lynx" });
    const pid = join(root, `${name}.pid`);
    await runIn(project, lynx, pid);
    await waitFor(() => existsSync(pid), "the script to start");
    const { terminalId } = await open(project, lynx);
    await remove(project);
    assert.equal(await running(lynx), 0, `${name}: its script was stopped`);
    assert.ok(
      !(await openIds()).includes(terminalId),
      `${name}: its terminal closed`,
    );
  }
});

// The next terrier listing asks it again.
const fresh = () =>
  runHost(Effect.flatMap(Terrier.Terrier, (terrier) => terrier.invalidate));

// A `terrier` first on PATH listing `listed`, failing while `broken`
// exists and holding while `held` exists, with the setting on, read
// afresh on every listing.
const fakeTerrier = async (name: string, listed: () => readonly string[]) => {
  const dir = join(root, `${name}-terrier`);
  mkdirSync(dir);
  const held = join(dir, "held");
  const holding = join(dir, "holding");
  const broken = join(dir, "broken");
  const answer = join(dir, "answer.json");
  const write = () =>
    writeFileSync(
      answer,
      JSON.stringify({ projects: listed().map((path) => ({ path })) }),
    );
  write();
  writeFileSync(
    join(dir, "terrier"),
    `#!/bin/sh\nif [ -f '${held}' ]; then touch '${holding}'; while [ -f '${held}' ]; do sleep 0.05; done; fi\n[ -f '${broken}' ] && exit 3\ncat '${answer}'\n`,
  );
  chmodSync(join(dir, "terrier"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path ?? ""}`;
  await runHost(Ops.patchGlobalConfig({ terrier: true }));
  return {
    held,
    holding,
    broken,
    relist: async () => {
      write();
      await fresh();
    },
    fresh,
    off: async () => {
      process.env.PATH = path;
      await runHost(Ops.patchGlobalConfig({ terrier: false }));
      await fresh();
    },
  };
};

const reapRemovedProjects = () =>
  runHost(
    Effect.flatMap(Scripts.Scripts, (scripts) => scripts.reapRemovedProjects),
  );

const busyNow = () =>
  runHost(Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy));

it("a terrier that can't be read takes no terrier project's scripts, and the store's sweep makes no quit ask", async () => {
  const tracked = join(root, "tracked");
  mkdirSync(tracked);
  git(tracked, "init", "-q", "-b", "main");
  git(tracked, "commit", "-q", "--allow-empty", "-m", "a");
  let listed: readonly string[] = [tracked];
  const terrier = await fakeTerrier("unread", () => listed);
  try {
    const project = (await runHost(freshProjects)).find(
      ({ path }) => path === tracked,
    );
    assert.ok(project !== undefined, "terrier lists the repo");
    // The sweep a store change runs, held in its read of the list.
    writeFileSync(terrier.held, "");
    await terrier.fresh();
    const sweeping = reapRemovedProjects();
    await waitFor(() => existsSync(terrier.holding), "the sweep's read");
    // Earlier proofs' scripts still run: what this sweep adds is nothing.
    const { engineChanges, inflightDeletes, inflightMoves } = await busyNow();
    assert.deepEqual(
      { engineChanges, inflightDeletes, inflightMoves },
      { engineChanges: [], inflightDeletes: 0, inflightMoves: 0 },
    );
    rmSync(terrier.held);
    await sweeping;
    const [primary] = await runHost(
      Ops.listWorktreeIdentities({ projectId: project.id }),
    );
    assert.ok(primary !== undefined);
    const pid = join(root, "unread.pid");
    await runIn(
      project,
      { ...primary, projectId: project.id } as Worktree,
      pid,
    );
    await waitFor(() => existsSync(pid), "the script to start");
    writeFileSync(terrier.broken, "");
    await terrier.fresh();
    await reapRemovedProjects();
    assert.equal(
      await running(primary as Worktree),
      1,
      "a listing terrier failed is no removal",
    );
    rmSync(terrier.broken);
    listed = [];
    await terrier.relist();
    await reapRemovedProjects();
    assert.equal(
      await running(primary as Worktree),
      0,
      "one terrier no longer lists is",
    );
  } finally {
    rmSync(terrier.held, { force: true });
    await terrier.off();
  }
});

it("a run started while the reap reads the list is not the reap's", async () => {
  const { repo, project } = await repoAt("readded");
  const lynx = await create(project, { worktreeName: "lynx" });
  const before = join(root, "readded-before.pid");
  await runIn(project, lynx, before);
  await waitFor(() => existsSync(before), "the first script to start");
  await runHost(Ops.removeProject(project.id));
  const terrier = await fakeTerrier("readded", () => []);
  try {
    writeFileSync(terrier.held, "");
    await terrier.fresh();
    const reaping = reapRemovedProjects();
    await waitFor(() => existsSync(terrier.holding), "the reap's read");
    const after = join(root, "readded-after.pid");
    await runIn(project, lynx, after);
    await waitFor(() => existsSync(after), "the second script to start");
    rmSync(terrier.held);
    await reaping;
    assert.equal(await running(lynx), 1, "the run started since stays");
    await runHost(addProject(repo));
  } finally {
    rmSync(terrier.held, { force: true });
    await terrier.off();
    await runHost(
      Effect.flatMap(Scripts.Scripts, (scripts) =>
        scripts.stopWorktree(lynx.id),
      ),
    );
  }
});
