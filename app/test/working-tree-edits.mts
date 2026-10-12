// Durable proof that a file edited outside the app reaches the
// worktree rows (the `worktrees:watch` view, which the sidebar and the
// worktree page read): through the host's watch on the working trees
// (host/lib/GitWatcher.ts) within a couple of seconds, with no window
// focused, and for an edit no watch saw: through a window here gaining
// focus (BackgroundFetch reads the rows again), and through a peer's
// `git:sweep` that is no renewal (its window regained focus, or its
// session landed), which its renewals are not.
//
// Run: pnpm test working-tree-edits.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type { Worktree } from "@shigomori/contracts/schemas";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, it } from "vitest";
import { worktreesViews } from "../host/ipc/modules/worktrees.ts";
import * as BackgroundFetch from "../host/lib/BackgroundFetch.ts";
import * as GitWatcher from "../host/lib/GitWatcher.ts";
import * as HostPushes from "../host/lib/HostPushes.ts";
import { addProject } from "../host/lib/projects/index.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";
import {
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";

scrubProcessGitEnv();
const { track, teardown } = makeTracker();
const git = sandboxGit();
let repo: string;

beforeAll(() => {
  initDataDirAt(engineDataDir);
  repo = join(tempDir("sm-edits-", track), "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "a");
});
afterAll(() => teardown());

let projectId = "";

// The rows' changed files as the view next says them, within `within`.
const changedCountWithin = (
  values: Queue.Dequeue<readonly Worktree[], unknown>,
  within: Duration.Input,
) =>
  Queue.take(values).pipe(
    Effect.map((rows) => rows[0]?.changedCount),
    Effect.timeoutOrElse({
      duration: within,
      orElse: () => Effect.succeed("no new rows" as const),
    }),
  );

it("an edit outside the app reaches the rows through the working tree's watch, with no focus", async () => {
  await runHost(
    Effect.gen(function* () {
      const project = yield* addProject(repo);
      projectId = project.id;
      const pushes = yield* HostPushes.HostPushes;
      const values = yield* Stream.toQueue(
        worktreesViews.watch({ projectId: project.id }),
        { capacity: "unbounded" },
      );
      const [first] = yield* Queue.take(values);
      assert.equal(first?.changedCount, 0);

      // The watch as the host's root wires it (process/layer.ts): an
      // edit is the project's files push.
      yield* Layer.build(
        GitWatcher.layer({
          onChange: () => {},
          onFilesChanged: (changed) =>
            Effect.runFork(
              HostPushes.push(worktreesContract, "filesChanged", {
                projectId: changed,
              }).pipe(Effect.provideService(HostPushes.HostPushes, pushes)),
            ),
          projects: () => [project],
        }).pipe(Layer.provide(NodeServices.layer)),
      );
      // Past the platform watch's first events (FSEvents hands a new
      // watch what came just before it).
      yield* Effect.sleep("500 millis");

      writeFileSync(join(repo, "b.txt"), "b\n");
      assert.equal(
        yield* changedCountWithin(values, "2 seconds"),
        1,
        "the edit reaches the rows within two seconds",
      );

      writeFileSync(join(repo, "a.txt"), "changed\n");
      assert.equal(yield* changedCountWithin(values, "2 seconds"), 2);
    }).pipe(Effect.scoped),
  );
});

it("each window here gaining focus reads the rows again, for an edit no watch saw", async () => {
  await runHost(
    Effect.gen(function* () {
      const pushes = yield* HostPushes.HostPushes;
      const values = yield* Stream.toQueue(
        worktreesViews.watch({ projectId }),
        { capacity: "unbounded" },
      );
      const [first] = yield* Queue.take(values);
      const before = first?.changedCount ?? 0;
      // The real one, its pushes as the host's root wires them.
      const context = yield* Layer.build(
        BackgroundFetch.layer({
          broadcast: (module, key, payload) => {
            Effect.runFork(
              HostPushes.push(module, key, payload).pipe(
                Effect.provideService(HostPushes.HostPushes, pushes),
              ),
            );
          },
          announceProjectChanged: () => {},
        }),
      );
      const fetch = Context.get(context, BackgroundFetch.BackgroundFetch);
      writeFileSync(join(repo, "d.txt"), "d\n");
      assert.equal(
        yield* changedCountWithin(values, "1 second"),
        "no new rows",
        "nothing watches the tree here",
      );
      fetch.setWindowFocused(true);
      assert.equal(yield* changedCountWithin(values, "2 seconds"), before + 1);
      // Focus moving to another of this machine's windows: the app stays
      // focused, and the window that gained it reads the rows again.
      writeFileSync(join(repo, "e.txt"), "e\n");
      fetch.setWindowFocused(true);
      assert.equal(yield* changedCountWithin(values, "2 seconds"), before + 2);
      // A peer's renewal of its sweep reads nothing again; its ask on a
      // focus or a landing does.
      writeFileSync(join(repo, "f.txt"), "f\n");
      yield* fetch.sweepForPeer(true);
      assert.equal(
        yield* changedCountWithin(values, "1 second"),
        "no new rows",
        "a renewal read the rows again",
      );
      yield* fetch.sweepForPeer(false);
      assert.equal(yield* changedCountWithin(values, "2 seconds"), before + 3);
    }).pipe(Effect.scoped),
  );
});
