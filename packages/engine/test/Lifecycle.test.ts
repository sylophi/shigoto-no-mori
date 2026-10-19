// The lifecycle runner against real shells: what a script is told, what
// it reports, and what it leaves running.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, it } from "vitest";
import * as Lifecycle from "../src/Lifecycle.ts";
import * as Paths from "../src/Paths.ts";
import * as ConfigProvider from "effect/ConfigProvider";

const scratch = mkdtempSync(join(tmpdir(), "engine-lifecycle-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const context: Lifecycle.ScriptContext = {
  project: { id: "P", name: "proj", path: scratch },
  worktree: {
    id: "W",
    name: "fox",
    branch: "fox",
    path: scratch,
    isExternal: false,
  },
  projectBranch: "main",
  defaultBranch: "origin/main",
  title: "A title",
  description: "With\0a NUL",
};

// The runner over this machine's shells, its data dir the scratch
// folder (where a run's output file goes).
const lifecycleLayer = Lifecycle.layer.pipe(
  Layer.provide(
    Paths.layer("prod").pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { HOME: scratch, SHIGOMORI_DATA_DIR: scratch },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

// The script's events and its answer.
const run = (command: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Lifecycle;
      const events: Lifecycle.LifecycleEvent[] = [];
      const answer = yield* lifecycle.run({
        command,
        slot: { kind: "setup" },
        context,
        color: false,
        report: (event) => Effect.sync(() => void events.push(event)),
      });
      return { events, answer };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

// Signal 0 only asks whether the process is there.
const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const output = (events: ReadonlyArray<Lifecycle.LifecycleEvent>) =>
  events
    .flatMap((event) =>
      event.event === "script" && event.kind === "data" ? [event.data] : [],
    )
    .join("");

it("tells the script its worktree, NULs dropped, and reports start, output and exit", async () => {
  const { events, answer } = await run(
    'printf "%s|%s|%s" "$SHIGOMORI_WORKTREE_NAME" "$SHIGOMORI_DEFAULT_BRANCH" "$SHIGOMORI_WORKTREE_DESCRIPTION"; exit 4',
  );
  assert.equal(output(events), "fox|origin/main|Witha NUL");
  assert.equal(answer.code, 4);
  const kinds = events.map((event) =>
    event.event === "script" ? event.kind : event.event,
  );
  assert.deepEqual([kinds[0], kinds.at(-1)], ["started", "exit"]);
});

it("leaves what the script started in the background running", async () => {
  const { events, answer } = await run("sleep 30 >/dev/null 2>&1 & echo $!");
  assert.equal(answer.code, 0);
  const pid = Number(output(events).trim());
  try {
    // Signal 0 only asks whether the process is there.
    assert.doesNotThrow(() => process.kill(pid, 0));
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

it("ends at the shell's exit while a child it left holds the output, which keeps running and writing", async () => {
  // Without redirections: the child holds the run's output, writing to
  // it, as a dev server started from a setup script does.
  const answered = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Lifecycle;
      const events: Lifecycle.LifecycleEvent[] = [];
      const answer = yield* lifecycle.run({
        command:
          // A hundred ticks, so a run that fails still leaves nothing.
          "(for i in $(seq 100); do echo tick; sleep 0.05; done) & echo $!; echo ready",
        slot: { kind: "setup" },
        context,
        color: false,
        report: (event) => Effect.sync(() => void events.push(event)),
      });
      const pid = Number(output(events).split("\n")[0]);
      yield* Effect.sleep("1500 millis");
      const alive = processAlive(pid);
      return { events, answer, pid, alive };
    }).pipe(Effect.provide(lifecycleLayer), Effect.timeout("10 seconds")),
  );
  try {
    assert.equal(answered.answer.code, 0);
    assert.equal(answered.alive, true);
    const kinds = answered.events.map((event) =>
      event.event === "script" ? event.kind : event.event,
    );
    assert.equal(kinds.at(-1), "exit");
    assert.match(output(answered.events), /^\d+\n(tick\n)*ready\n/);
  } finally {
    process.kill(answered.pid, "SIGKILL");
  }
});

it("reports all a script wrote just before it exited", async () => {
  const { events, answer } = await run(
    "head -c 1048576 /dev/zero | tr '\\0' a; exit 3",
  );
  assert.equal(answer.code, 3);
  assert.equal(output(events), "a".repeat(1_048_576));
});

it("keeps what a child of the last run writes out of the next run's output", async () => {
  const first = await run("(sleep 0.5; echo stale) & echo first");
  assert.equal(first.answer.code, 0);
  const { events } = await run("sleep 1.5; echo second");
  assert.equal(output(events), "second\n");
});
