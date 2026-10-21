import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it, vi } from "vitest";
import * as Launchers from "../src/Launchers.ts";
import * as Open from "../src/Open.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

it("lists a project's row: installed apps, its GitHub page, custom ones, by use", async () => {
  const recent = Date.now() - 60_000;
  const repo = box.repo("repo");
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/Me/Repo.git"],
    { cwd: repo },
  );
  box.write("registry.json", {
    projects: [{ id: "P", name: "repo", path: repo }],
  });
  box.write("config.json", {
    launchers: [
      { id: "a", label: "zsh here", command: "zsh" },
      { label: "no id", command: "x" },
    ],
    hiddenLaunchers: ["app:finder", "custom:gone"],
  });
  box.write("projects/P/project.json", {
    defaultBranch: "main",
    launchers: [{ id: "b", label: "Agent", command: "claude" }],
  });
  box.write("state.json", {
    launcherUseLog: {
      "custom:a": [1, recent, recent],
      "web:github": [recent],
    },
  });

  const row = (await box.engine(
    Effect.flatMap(Effect.service(Launchers.Launchers), (launchers) =>
      launchers.row({ id: "P", path: repo }),
    ),
  )) as Launchers.LauncherRow;
  assert.deepEqual(
    [row.entries.slice(0, 2).map(({ id }) => id), row.hiddenCount],
    [["custom:a", "web:github"], 1],
  );
  assert.ok(row.entries.some(({ id }) => id === "custom:b"));
});

it("a custom launcher's command keeps running once it is launched", async () => {
  const repo = box.repo("repo");
  const pidFile = join(box.home, "launched.pid");
  box.write("registry.json", {
    projects: [{ id: "P", name: "repo", path: repo }],
  });
  box.write("config.json", {
    launchers: [
      {
        id: "w",
        label: "Watcher",
        command: `echo $$ > '${pidFile}'; exec sleep 30`,
      },
    ],
  });
  await box.engine(
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const located = yield* worktrees.resolve(yield* worktrees.nowhere, {
        projectId: "P",
        worktreeId: worktreeIdFromPath(repo),
      });
      yield* (yield* Open.Open).open(located, "Watcher");
    }),
  );
  await vi.waitFor(
    () =>
      assert.ok(existsSync(pidFile) && readFileSync(pidFile, "utf8") !== ""),
    { timeout: 5000 },
  );
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(pid > 0);
  try {
    // The launch's close waits out a group it signalled, so a killed one
    // is gone by now.
    assert.doesNotThrow(() => process.kill(pid, 0));
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
});
