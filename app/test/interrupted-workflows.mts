// Durable proof that a worktree move or removal killed at any step is
// finished or undone by the next start (the commit points in
// packages/engine/README.md, and the engine's src/worktrees/moving.ts
// and removing.ts). The terminal sm runs each workflow, held at one
// step by wrappers over git, cp and rmdir
// (packages/engine/test/lib/stopAt.ts) and killed there with SIGKILL,
// as a crash would. Then:
//   - the app's start (the host's engine, whose start resumes the moves)
//     on one data dir, and `sm doctor --fix` on another, leave each moved
//     worktree where git lists it, whole, with its auto-pull mark and
//     title under the id it has there, no partial copy and no record of
//     the move;
//   - a move killed before git moved it is undone, one killed after is
//     finished, the copy across volumes (git's refusal faked) included;
//   - a removal killed after git removed the checkout leaves nothing a
//     worktree made later at the same path takes over;
//   - the migration's move of a 2.x data dir's worktrees into wt/,
//     killed at each step, is finished by the next run, each worktree's
//     mark and title carried.
//
// Run: pnpm test interrupted-workflows.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as Schema from "effect/Schema";
import { afterAll, it } from "vitest";
import {
  stopWrappers,
  type Stop,
} from "../../packages/engine/test/lib/stopAt.ts";
import {
  createCliRunner,
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  scrubbedGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";
import { addProject, builtSm, hostEngine } from "./lib/smBinary.mts";
import { own, pidIn } from "../../test/testProcesses.mts";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";

const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv();
const git = sandboxGit(gitEnv);
const { track, teardown } = makeTracker();
afterAll(teardown);

type Case = {
  readonly name: string;
  readonly stop: (to: string, from: string) => Stop;
  readonly crossVolume?: boolean;
  // Where git lists the worktree once the next start is through.
  readonly ends: "from" | "to";
  // Killed past the commit, so no record of the move is left.
  readonly committed?: boolean;
};

const MOVES: ReadonlyArray<Case> = [
  {
    name: "before git's move",
    stop: () => ({ tool: "git", when: "before", match: "worktree move" }),
    ends: "from",
  },
  {
    name: "after git's move",
    stop: () => ({ tool: "git", when: "after", match: "worktree move" }),
    ends: "to",
  },
  {
    name: "after the commit, pruning the old folders",
    stop: (_to, from) => ({
      tool: "rmdir",
      when: "before",
      match: dirname(from),
    }),
    ends: "to",
    committed: true,
  },
  {
    name: "across volumes, the copy made",
    stop: () => ({ tool: "cp", when: "after", match: ".partial-" }),
    crossVolume: true,
    ends: "from",
  },
  {
    name: "across volumes, the copy renamed in",
    stop: (to) => ({
      tool: "git",
      when: "before",
      match: `worktree repair -- ${to}`,
    }),
    crossVolume: true,
    ends: "from",
  },
  {
    name: "across volumes, git pointed at the copy",
    stop: (to) => ({
      tool: "git",
      when: "after",
      match: `worktree repair -- ${to}`,
    }),
    crossVolume: true,
    ends: "to",
  },
];

const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      path: Schema.String,
      autoPull: Schema.Boolean,
      title: Schema.optional(Schema.String),
    }),
  ),
);
const decodeReport = Schema.decodeUnknownSync(
  Schema.Struct({ checks: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);

// A data dir for one recovery path, the terminal sm on it.
function dataDirFor(label: string) {
  const root = tempDir(`sm-cut-${label}-`, track);
  const dataDir = join(root, "data");
  const binary = builtSm();
  const env = { ...process.env, SHIGOMORI_DATA_DIR: dataDir };
  const { sm, runCli } = createCliRunner(binary, env);
  const rows = async (project: string) => {
    const { docs } = await sm("worktrees", "list", "-p", project);
    return decodeRows(docs.at(-1));
  };
  // Runs sm held at `stop`, kills its whole process group there.
  const killedAt = async (args: string[], stop: Stop, crossVolume = false) => {
    const mark = join(root, `held-${Date.now()}`);
    const child = own(
      spawn(binary, ["--json", ...args], {
        env: {
          ...env,
          ...stopWrappers(join(root, "bin"), {
            stop,
            mark,
            seconds: 600,
            crossVolume,
          }),
        },
        detached: true,
        stdio: "ignore",
      }),
    );
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    // The wrapper's pid, once it has written it whole.
    const held = () =>
      existsSync(mark) ? pidIn(readFileSync(mark, "utf8")) : undefined;
    await waitFor(
      () => held() !== undefined,
      `sm ${args.join(" ")} held at ${stop.tool} ${stop.when} ${stop.match}`,
      30_000,
    );
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    // The engine runs each command in a process group of its own, which
    // the held wrapper is in.
    const group = pidIn(
      execFileSync("ps", ["-o", "pgid=", "-p", String(held())], {
        encoding: "utf8",
      }),
    );
    assert.ok(group !== undefined, "the held wrapper has no group");
    process.kill(-group, "SIGKILL");
    await exited;
  };
  return { root, dataDir, sm, runCli, rows, killedAt };
}

// A project with one worktree, marked and titled, its files committed.
async function projectWithFox(
  place: ReturnType<typeof dataDirFor>,
  name: string,
) {
  const repo = join(place.root, name);
  git(place.root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), `${name}\n`);
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "first");
  await addProject(place.sm, repo);
  await place.sm(
    "worktrees",
    "create",
    "fox",
    "-p",
    name,
    "--no-cd",
    "--no-setup",
  );
  await place.sm("worktrees", "autopull", "on", "fox", "-p", name);
  await place.sm(
    "worktrees",
    "describe",
    "fox",
    "-p",
    name,
    "-t",
    `${name}'s fox`,
  );
  const fox = (await place.rows(name)).find((row) => row.name === "fox");
  assert.ok(fox);
  return { repo, fox };
}

type Cut = { project: string; from: string; to: string; ends: "from" | "to" };

async function cutMoves(place: ReturnType<typeof dataDirFor>): Promise<Cut[]> {
  const cuts: Cut[] = [];
  for (const [index, cut] of MOVES.entries()) {
    const project = `p${index}`;
    const { fox } = await projectWithFox(place, project);
    // A rename, so the worktree stays managed, which an external one's
    // title isn't shown for.
    const to = join(dirname(fox.path), "vixen");
    await place.killedAt(
      ["worktrees", "move", "fox", to, "-p", project],
      cut.stop(to, fox.path),
      cut.crossVolume,
    );
    cuts.push({ project, from: fox.path, to, ends: cut.ends });
  }
  return cuts;
}

async function assertRecovered(
  place: ReturnType<typeof dataDirFor>,
  cuts: Cut[],
) {
  for (const [index, cut] of cuts.entries()) {
    const what = `${MOVES[index]?.name} (${cut.project})`;
    const rows = (await place.rows(cut.project)).filter(
      (row) => row.path === cut.from || row.path === cut.to,
    );
    assert.equal(rows.length, 1, `${what}: one fox, ${JSON.stringify(rows)}`);
    const [fox] = rows;
    assert.ok(fox);
    const at = cut.ends === "to" ? cut.to : cut.from;
    const gone = cut.ends === "to" ? cut.from : cut.to;
    assert.equal(fox.path, at, `${what}: fox where git lists it`);
    assert.equal(
      readFileSync(join(at, "README.md"), "utf8"),
      `${cut.project}\n`,
      what,
    );
    assert.ok(!existsSync(gone), `${what}: nothing left at ${gone}`);
    assert.equal(fox.autoPull, true, `${what}: the mark under the id it has`);
    assert.equal(fox.title, `${cut.project}'s fox`, `${what}: the title too`);
    const parent = dirname(cut.to);
    const partials = existsSync(parent)
      ? readdirSync(parent).filter((entry) => entry.includes(".partial-"))
      : [];
    assert.deepEqual(partials, [], `${what}: no partial copy`);
  }
  const report = decodeReport((await place.sm("doctor")).docs.at(-1));
  assert.ok(
    !report.checks.some((check) => check.id === "project-interrupted-moves"),
    "no move left cut short",
  );
}

// A removal killed after git removed the checkout, and a worktree made
// at its path after the next start.
async function cutRemoval(place: ReturnType<typeof dataDirFor>) {
  await projectWithFox(place, "gone");
  await place.killedAt(["worktrees", "rm", "fox", "-p", "gone", "-f"], {
    tool: "git",
    when: "after",
    match: "worktree remove",
  });
}
async function assertRemovalLeftNothing(place: ReturnType<typeof dataDirFor>) {
  assert.ok(!(await place.rows("gone")).some((row) => row.name === "fox"));
  // The kill came before the branch went, which stays as a branch.
  await place.sm(
    "worktrees",
    "create",
    "fox",
    "-b",
    "fox-again",
    "-p",
    "gone",
    "--no-cd",
    "--no-setup",
  );
  const fox = (await place.rows("gone")).find((row) => row.name === "fox");
  assert.ok(fox);
  assert.equal(
    fox.autoPull,
    false,
    "the new fox takes no mark of the old one's",
  );
  assert.equal(fox.title, undefined, "nor its title");
}

it("the app's start finishes or undoes each move a crash cut short", async () => {
  const place = dataDirFor("app");
  const cuts = await cutMoves(place);
  await cutRemoval(place);
  const report = decodeReport((await place.sm("doctor")).docs.at(-1));
  assert.equal(
    report.checks.filter((check) => check.id === "project-interrupted-moves")
      .length,
    MOVES.filter((cut) => cut.committed !== true).length,
    "the doctor reports each cut-short move",
  );
  const engine = await hostEngine(
    place.dataDir,
    join(dirname(builtSm()), "nativefs"),
  );
  await engine.close();
  await assertRecovered(place, cuts);
  await assertRemovalLeftNothing(place);
}, 300_000);

it("`sm doctor --fix` finishes or undoes each move a crash cut short", async () => {
  const place = dataDirFor("doctor");
  const cuts = await cutMoves(place);
  await cutRemoval(place);
  await place.sm("doctor", "--fix", "--yes");
  await assertRecovered(place, cuts);
  await assertRemovalLeftNothing(place);
}, 300_000);

// A 2.x data dir with worktrees a and b under its managed root, a marked
// and titled under its v2 id, which `sm doctor --fix` migrates.
async function v2DataDir(place: ReturnType<typeof dataDirFor>) {
  const repo = join(place.root, "repo");
  git(place.root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "repo\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "first");
  const v2 = join(place.dataDir, "worktrees", "repo");
  for (const name of ["a", "b"]) {
    git(repo, "worktree", "add", "-q", "-b", name, join(v2, name));
  }
  const a = worktreeIdFromPath(join(v2, "a"));
  mkdirSync(join(place.dataDir, "projects", "P1", "worktrees"), {
    recursive: true,
  });
  writeFileSync(
    join(place.dataDir, "registry.json"),
    JSON.stringify({
      projects: [{ id: "P1", name: "repo", path: repo }],
      autoPullWorktrees: { [a]: true },
    }),
  );
  writeFileSync(
    join(place.dataDir, "projects", "P1", "worktrees", `${a}.json`),
    JSON.stringify({ title: "a's title" }),
  );
  return { v2, wt: join(place.dataDir, "wt", "repo") };
}

it("the migration's move into wt/ killed at each step is finished by the next run", async () => {
  const stops: ReadonlyArray<(v2: string) => Stop> = [
    () => ({ tool: "git", when: "before", match: "worktree move" }),
    () => ({ tool: "git", when: "after", match: "worktree move" }),
    (v2) => ({ tool: "rmdir", when: "before", match: v2 }),
  ];
  for (const [index, stop] of stops.entries()) {
    const place = dataDirFor(`migration-${index}`);
    const { v2, wt } = await v2DataDir(place);
    await place.killedAt(["doctor", "--fix", "--yes"], stop(v2));
    await place.sm("doctor", "--fix", "--yes");
    const rows = (await place.rows("repo")).filter(
      (row) => row.name !== "repo",
    );
    assert.deepEqual(
      rows.map((row) => row.path).toSorted(),
      [join(wt, "a"), join(wt, "b")],
      `step ${index}: both moved into wt/`,
    );
    const a = rows.find((row) => row.name === "a");
    assert.equal(a?.autoPull, true, `step ${index}: a's mark carried`);
    assert.equal(a?.title, "a's title", `step ${index}: a's title carried`);
    assert.ok(!existsSync(v2), `step ${index}: the v2 root is gone`);
  }
}, 300_000);
