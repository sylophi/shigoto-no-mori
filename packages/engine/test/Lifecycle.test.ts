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
    }).pipe(
      Effect.provide(Lifecycle.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  );

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
