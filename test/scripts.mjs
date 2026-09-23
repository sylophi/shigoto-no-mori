// Durable proof for the script runner (host/lib/scripts/index.ts):
//
// - the output batching rule, on the Stream the runner drains, under
//   TestClock: a read opens a batch that goes out 16 ms after it, or
//   the moment it holds 64 KiB, or the moment one of the runner's own
//   events arrives, and an idle run holds no timer;
// - the same rule end to end against a REAL pty (node-pty, headless):
//   two reads a frame apart go out as two events, two back to back as
//   one, and a 200 KB burst arrives whole;
// - a kill escalates SIGTERM, then SIGKILL once the grace runs out, and
//   a script that honors SIGTERM goes without waiting the grace out;
// - withDeleteInflight refuses a script start for its worktree (and a
//   second mutation of it) while it holds the mark, and always clears
//   the mark, even when the mutation fails.
//
// Runs under test/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. Run: pnpm test scripts.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { delay, makeProof, waitFor } from "./lib/checkKit.mjs";

// A plain shell, so no login profile of the machine running the check
// runs ahead of the command.
process.env.SHELL = "/bin/sh";

const { initDataDirAt } = await import("../host/lib/util/paths.ts");
const {
  OUTPUT_FLUSH_BYTES,
  batchScriptOutput,
  getBusyOperations,
  killAllScripts,
  makeScriptOutputQueue,
  registerInflightContributor,
  startScript,
  withDeleteInflight,
} = await import("../host/lib/scripts/index.ts");

const { check, done, fail } = makeProof("scripts proof");

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "sm-scripts-data-")));
initDataDirAt(dataDir);
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sm-scripts-cwd-")));

// Lets forked fibers run what is ready. Real time, which the TestClock
// ignores.
const settle = () => delay(5);

// The batcher on its own TestClock runtime, fed by hand.
function batcher(track) {
  const rt = ManagedRuntime.make(TestClock.layer());
  track(() => rt.dispose());
  const queue = makeScriptOutputQueue();
  const batches = [];
  rt.runFork(
    Stream.runForEach(batchScriptOutput(queue), (batch) =>
      Effect.sync(() => batches.push(batch)),
    ),
  );
  return {
    batches,
    offer: (event) => Queue.offerUnsafe(queue, event),
    data: (data) => Queue.offerUnsafe(queue, { kind: "data", data }),
    adjust: (ms) => rt.runPromise(TestClock.adjust(ms)),
  };
}

// A script run with its events collected.
function run(track, command, worktreeId = "wt-1") {
  const events = [];
  const runId = startScript({
    command,
    scriptName: "check",
    worktree: { id: worktreeId, name: "wt", branch: "main", path: cwd },
    project: { id: "proj", path: cwd, name: "proj" },
    projectBranch: "main",
    defaultBranch: "main",
    notify: (event) => events.push(event),
  });
  const exited = () => events.some((event) => event.kind === "exit");
  track(() => killAllScripts({ graceMs: 200 }));
  return {
    runId,
    events,
    data: () => events.filter((event) => event.kind === "data"),
    exited,
    waitExit: (timeoutMs = 10_000) => waitFor(exited, "script exit", timeoutMs),
  };
}

async function main() {
  console.log("scripts proof\n");

  await check(
    "reads within a frame go out as one batch at 16 ms",
    async (track) => {
      const b = batcher(track);
      b.data("a");
      await settle();
      b.data("b");
      b.data("c");
      await settle();
      await b.adjust(15);
      await settle();
      assert.equal(b.batches.length, 0, "flushed before the frame was up");
      await b.adjust(1);
      await settle();
      assert.deepEqual(b.batches, [{ data: "abc", closedBy: null }]);
    },
  );

  await check("the window starts at the batch's first read", async (track) => {
    const b = batcher(track);
    // Idle time before a read is not part of its window.
    await b.adjust(100);
    b.data("late");
    await settle();
    await b.adjust(15);
    await settle();
    assert.equal(b.batches.length, 0);
    await b.adjust(1);
    await settle();
    assert.deepEqual(b.batches, [{ data: "late", closedBy: null }]);
    // Nothing queued: an idle run emits nothing, however long.
    await b.adjust(1_000);
    await settle();
    assert.equal(b.batches.length, 1);
  });

  await check(
    "the byte cap flushes without waiting out the frame",
    async (track) => {
      const b = batcher(track);
      const half = "x".repeat(OUTPUT_FLUSH_BYTES / 2);
      b.data(half);
      b.data(half);
      b.data("tail");
      await settle();
      assert.equal(b.batches.length, 1, "the full batch should be out at once");
      assert.equal(b.batches[0].data.length, OUTPUT_FLUSH_BYTES);
      // The read past the cap opened the next batch, which waits out its
      // frame.
      await b.adjust(16);
      await settle();
      assert.equal(b.batches[1]?.data, "tail");
      // A single read at the cap goes out on its own, at once.
      b.data("y".repeat(OUTPUT_FLUSH_BYTES));
      await settle();
      // A read landing in an open batch that takes it past the cap sends
      // the whole batch, at once.
      b.data("z");
      await settle();
      b.data("y".repeat(OUTPUT_FLUSH_BYTES));
      await settle();
      assert.deepEqual(
        b.batches.map((batch) => batch.data.length),
        [OUTPUT_FLUSH_BYTES, 4, OUTPUT_FLUSH_BYTES, OUTPUT_FLUSH_BYTES + 1],
      );
    },
  );

  await check(
    "the runner's own events close the batch in order",
    async (track) => {
      const b = batcher(track);
      b.data("out");
      b.offer({ kind: "notice", data: "[stop]" });
      b.data("more");
      b.offer({ kind: "exit", code: null });
      await settle();
      assert.deepEqual(b.batches, [
        { data: "out", closedBy: { kind: "notice", data: "[stop]" } },
        { data: "more", closedBy: { kind: "exit", code: null } },
      ]);
    },
  );

  await check(
    "a real pty: reads a frame apart are two events, back to back one",
    async (track) => {
      const apart = run(track, "printf a; sleep 0.1; printf b");
      await apart.waitExit();
      assert.deepEqual(
        apart.data().map((event) => event.data),
        ["a", "b"],
      );
      assert.deepEqual(apart.events.at(-1), {
        runId: apart.runId,
        kind: "exit",
        code: 0,
      });

      const together = run(track, "printf a; printf b");
      await together.waitExit();
      assert.deepEqual(
        together.data().map((event) => event.data),
        ["ab"],
      );
    },
  );

  await check("a real pty: a 200 KB burst arrives whole", async (track) => {
    const burst = run(track, "head -c 200000 /dev/zero | tr '\\0' x");
    await burst.waitExit();
    const text = burst
      .data()
      .map((event) => event.data)
      .join("");
    assert.equal(text, "x".repeat(200_000));
    assert.ok(burst.data().length >= 3, "the byte cap should split the burst");
    for (const event of burst.data()) {
      assert.ok(
        event.data.length <= 2 * OUTPUT_FLUSH_BYTES,
        `a batch of ${event.data.length} bytes outgrew the cap`,
      );
    }
  });

  await check(
    "a kill escalates SIGTERM, then SIGKILL after the grace",
    async (track) => {
      const stubborn = run(track, "trap '' TERM; printf ready; sleep 30");
      await waitFor(
        () => stubborn.data().some((event) => event.data.includes("ready")),
        "the script to start",
      );
      const graceMs = 400;
      const started = Date.now();
      await killAllScripts({ graceMs });
      const elapsed = Date.now() - started;
      assert.ok(
        stubborn.exited(),
        "the kill returned before the exit went out",
      );
      assert.ok(
        elapsed >= graceMs,
        `SIGTERM alone ended a script that ignores it (${elapsed} ms)`,
      );
      assert.ok(elapsed < graceMs + 3_000, `SIGKILL came late (${elapsed} ms)`);
      const exit = stubborn.events.at(-1);
      assert.equal(exit.kind, "exit");
      assert.equal(exit.code, null, "a cancelled run reports no exit code");
      const notice = stubborn.events.at(-2);
      assert.equal(notice.kind, "data");
      assert.match(notice.data, /\[App quit\]/);

      const polite = run(track, "printf ready; sleep 30");
      await waitFor(
        () => polite.data().some((event) => event.data.includes("ready")),
        "the script to start",
      );
      const politeStart = Date.now();
      await killAllScripts({ graceMs: 5_000 });
      assert.ok(polite.exited());
      assert.ok(
        Date.now() - politeStart < 3_000,
        "a script that honors SIGTERM waited out the grace",
      );
    },
  );

  await check(
    "withDeleteInflight refuses a script start while it holds the mark",
    async (track) => {
      const worktreeId = "wt-deleting";
      let refusedStart = null;
      let refusedSecond = null;
      let busyInside = 0;
      const result = await withDeleteInflight(worktreeId, "busy", async () => {
        busyInside = getBusyOperations().inflightDeletes;
        try {
          run(track, "true", worktreeId);
        } catch (error) {
          refusedStart = error;
        }
        refusedSecond = await withDeleteInflight(
          worktreeId,
          "busy",
          async () => {
            throw new Error("the second mutation ran");
          },
        ).catch((error) => error);
        return 42;
      });
      assert.equal(result, 42);
      assert.match(
        refusedStart?.message ?? "",
        /This worktree is being deleted\./,
      );
      assert.equal(refusedSecond?.message, "busy");
      assert.equal(busyInside, 1);
      assert.equal(getBusyOperations().inflightDeletes, 0, "the mark stayed");

      // A failed mutation clears the mark too, and its error is the one
      // the caller sees.
      const boom = new Error("boom");
      await assert.rejects(
        withDeleteInflight(worktreeId, "busy", async () => {
          throw boom;
        }),
        (error) => error === boom,
      );
      assert.equal(getBusyOperations().inflightDeletes, 0);

      // Unmarked, the worktree runs scripts again.
      const after = run(track, "true", worktreeId);
      await after.waitExit();
    },
  );

  await check(
    "an inflight contributor counts until it unregisters",
    async () => {
      const unregister = registerInflightContributor(() => 3);
      assert.equal(getBusyOperations().inflightDeletes, 3);
      unregister();
      assert.equal(getBusyOperations().inflightDeletes, 0);
    },
  );

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  done();
  // node-pty's native handles can outlive the last run by a moment.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
}

main().catch(fail);
