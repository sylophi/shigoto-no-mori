import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it, onTestFinished } from "vitest";
import { codeOf } from "../src/errorDocument.ts";
import * as Scripts from "../src/Scripts.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const run = <A>(
  program: (scripts: Scripts.Scripts["Service"]) => Effect.Effect<A, unknown>,
) => box.engine(Effect.flatMap(Effect.service(Scripts.Scripts), program));

it("keeps another branch's scripts behind the ones they followed", () => {
  assert.deepEqual(
    Scripts.mergeArrangedOrder(
      ["setup", "dev", "deploy", "test", "lint"],
      ["test", "dev", "lint"],
    ),
    ["setup", "test", "dev", "deploy", "lint"],
  );
});

it("stores the sort, the default by its absence, and arranges against the stored order", async () => {
  const repo = box.repo("repo", {
    "package.json": JSON.stringify({ scripts: { a: "1", b: "2" } }),
  });
  const listed = (await run((scripts) =>
    Effect.gen(function* () {
      yield* scripts.setSort("P", "alphabetical");
      yield* scripts.arrange("P", ["x", "a"]);
      yield* scripts.arrange("P", ["b", "a"]);
      const sorted = yield* scripts.list({
        projectId: "P",
        worktreePath: repo,
      });
      yield* scripts.setSort("P", "frequent");
      const reset = yield* scripts.list({ projectId: "P", worktreePath: repo });
      return [sorted.sort, sorted.order, reset.sort];
    }),
  )) as unknown[];
  assert.deepEqual(listed, ["alphabetical", ["x", "b", "a"], "frequent"]);
});

it("puts a script on the launch row and takes it off, once each", async () => {
  const rows = await run((scripts) =>
    Effect.gen(function* () {
      yield* scripts.setOnLaunchRow("P", "dev", true);
      yield* scripts.setOnLaunchRow("P", "test", true);
      yield* scripts.setOnLaunchRow("P", "dev", true);
      const both = yield* scripts.launchRow("P");
      yield* scripts.setOnLaunchRow("P", "dev", false);
      return [both, yield* scripts.launchRow("P")];
    }),
  );
  assert.deepEqual(rows, [["dev", "test"], ["test"]]);
});

it("counts a run in the project's use stats", async () => {
  const repo = box.repo("repo", {
    "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
  });
  const usage = (await run((scripts) =>
    Effect.gen(function* () {
      yield* scripts.recordRun("P", "dev");
      return (yield* scripts.list({ projectId: "P", worktreePath: repo }))
        .usage;
    }),
  )) as Record<string, { recentCount: number }>;
  assert.equal(usage.dev?.recentCount, 1);
});

it("finds a script named whole, or as a runner and a recipe in two words", () => {
  const scripts = [
    { name: "build", runner: undefined },
    { name: "just build", runner: "just" as const },
    { name: "make test", runner: "make" as const },
  ];
  const cases: ReadonlyArray<
    readonly [ReadonlyArray<string>, string, ReadonlyArray<string>]
  > = [
    [["build", "--watch"], "build", ["--watch"]],
    [["just build"], "just build", []],
    [["just", "build", "x"], "just build", ["x"]],
    [["make", "test"], "make test", []],
  ];
  for (const [positionals, name, extra] of cases) {
    const found = Scripts.findScript(scripts, positionals);
    assert.deepEqual(
      [found?.script.name, found?.extra],
      [name, extra],
      positionals.join(" "),
    );
  }
  assert.equal(Scripts.findScript(scripts, ["make", "nope"]), undefined);
});

it("lists package.json's scripts, then the justfile's and the Makefile's, each with its file and name there", async () => {
  const repo = box.repo("repo", {
    "package.json": JSON.stringify({ scripts: { dev: "vite", build: "b" } }),
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    justfile: "check:\n    echo check\n",
    Makefile: "build:\n\tgo build\n",
  });
  const listed = (await run((scripts) =>
    scripts.list({ projectId: "P", worktreePath: repo }),
  )) as Scripts.ScriptsList;
  assert.equal(listed.packageManager, "pnpm");
  assert.deepEqual(listed.files, ["package.json", "justfile", "Makefile"]);
  assert.deepEqual(listed.scripts, [
    { name: "dev", command: "vite", file: "package.json", label: "dev" },
    { name: "build", command: "b", file: "package.json", label: "build" },
    {
      name: "just check",
      command: "echo check",
      file: "justfile",
      label: "check",
    },
    {
      name: "make build",
      command: "go build",
      file: "Makefile",
      label: "build",
    },
  ]);
  assert.deepEqual(listed.usage["just check"], { lastUsed: 0, recentCount: 0 });
});

it("lists a justfile alone with no manager", async () => {
  const repo = box.repo("repo", { ".justfile": "check:\n    echo check\n" });
  const listed = (await run((scripts) =>
    scripts.list({ projectId: "P", worktreePath: repo }),
  )) as Scripts.ScriptsList;
  assert.equal(listed.packageManager, null);
  assert.deepEqual(listed.files, [".justfile"]);
});

it("is no-scripts without a script file, and leaves out one that doesn't parse unless it is alone", async () => {
  const empty = box.repo("empty");
  const none = await run((scripts) => Effect.flip(scripts.readScripts(empty)));
  assert.ok(none instanceof Scripts.NoScripts);
  assert.equal(codeOf(none), "no-scripts");

  const repo = box.repo("broken", {
    "package.json": '{"scripts": {',
    justfile: "build:\n    go build\n",
  });
  const read = (await run((scripts) => scripts.readScripts(repo))) as {
    scripts: ReadonlyArray<{ name: string }>;
    files: ReadonlyArray<string>;
  };
  assert.deepEqual(read.files, ["justfile"]);
  assert.deepEqual(
    read.scripts.map(({ name }) => name),
    ["just build"],
  );
  rmSync(join(repo, "justfile"));
  const alone = await run((scripts) => Effect.flip(scripts.readScripts(repo)));
  assert.ok(alone instanceof Scripts.UnreadableScripts);
  assert.equal(codeOf(alone), undefined);
});

it("runs a recipe with just and a target with make at their own names, and says which tool is missing", async () => {
  // A PATH with just on it and nothing else, make included.
  const bin = join(box.home, "only-just");
  mkdirSync(bin);
  writeFileSync(join(bin, "just"), "#!/bin/sh\n", { mode: 0o755 });
  const own = sandbox({ env: { PATH: bin } });
  onTestFinished(() => own.remove());
  const repo = own.repo("repo", {
    justfile: "build:\n    go build\n",
    Makefile: "test:\n\tgo test\n",
  });
  const worktree = { path: repo, name: "repo" };
  const [whole, split, refused] = (await own.engine(
    Effect.flatMap(Effect.service(Scripts.Scripts), (scripts) =>
      Effect.all([
        scripts.command({ worktree, script: "just build", extra: ["x"] }),
        scripts.command({ worktree, script: "just", extra: ["build", "y"] }),
        Effect.flip(
          scripts.command({ worktree, script: "make test", extra: [] }),
        ),
      ]),
    ),
  )) as [
    { program: string; args: ReadonlyArray<string>; script: string },
    { program: string; args: ReadonlyArray<string>; script: string },
    Scripts.ScriptRefused,
  ];
  assert.equal(whole.program, join(bin, "just"));
  assert.deepEqual([whole.args, whole.script], [["build", "x"], "just build"]);
  assert.deepEqual([split.args, split.script], [["build", "y"], "just build"]);
  assert.equal(refused.reason, "no-tool");
  assert.equal(refused.message, "make isn't on PATH.");
});
