// A command run to its end, or past its deadline ended with it, one
// that ignores SIGTERM too, on the spawner every graph provides
// (`childDefaults`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { it } from "vitest";
import {
  CommandTimedOut,
  captureWithin,
  exec,
  childDefaults,
  parseLstart,
  startOf,
  stillRunning,
  UNKNOWN_BIRTH,
} from "../src/processes.ts";

const platform = childDefaults.pipe(Layer.provideMerge(NodeServices.layer));

const run = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
) => Effect.runPromise(Effect.exit(Effect.provide(effect, platform)));

it("ends a command past its deadline, and fails naming it", async () => {
  // A duration no other sleep on the machine has, to find it by.
  const seconds = `60.${process.pid}${Date.now() % 100_000}`;
  const exit = await run(
    Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
      captureWithin(spawner, "sleep", [seconds], "200 millis"),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  assert.ok(
    Option.getOrUndefined(Exit.findErrorOption(exit)) instanceof
      CommandTimedOut,
    String(exit),
  );
  // The command went with it.
  const running = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim() === `sleep ${seconds}`);
  assert.deepEqual(running, []);
});

it("ends a command that ignores SIGTERM past exec's timeout", async () => {
  const started = Date.now();
  const exit = await run(
    exec("perl", ["-e", '$SIG{TERM} = "IGNORE"; sleep 60'], {
      timeout: "200 millis",
    }),
  );
  assert.ok(Exit.isFailure(exit));
  assert.match(String(exit), /timed out/);
  assert.ok(Date.now() - started < 10_000, "ended by the SIGKILL after");
});

it("ends any spawn that ignores SIGTERM when its caller gives up, one that set no grace of its own included", async () => {
  const started = Date.now();
  const exit = await run(
    Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
      spawner.exitCode(
        ChildProcess.make("perl", ["-e", '$SIG{TERM} = "IGNORE"; sleep 60']),
      ),
    ).pipe(Effect.timeout("200 millis")),
  );
  assert.ok(Exit.isFailure(exit));
  assert.ok(Date.now() - started < 10_000, "ended by the SIGKILL after");
});

it("another birth is another process, and an unknown one is never taken over", async () => {
  const born = await run(startOf(process.pid));
  assert.ok(Exit.isSuccess(born) && Option.isSome(born.value), String(born));
  const birth = born.value.value;
  assert.deepEqual(
    await run(stillRunning(process.pid, birth)),
    Exit.succeed(true),
  );
  assert.deepEqual(
    await run(stillRunning(process.pid, birth - 60_000)),
    Exit.succeed(false),
  );
  assert.deepEqual(
    await run(stillRunning(process.pid, UNKNOWN_BIRTH)),
    Exit.succeed(true),
  );
});

it("reads lstart as ps prints it in UTC, and nothing else", () => {
  assert.deepEqual(
    parseLstart("Sat Oct 17 03:21:24 2026\n"),
    Option.some(Date.UTC(2026, 9, 17, 3, 21, 24)),
  );
  assert.deepEqual(parseLstart("Sat Okt 17 03:21:24 2026"), Option.none());
  assert.deepEqual(parseLstart(""), Option.none());
});

it("no child inherits the shell hook's directive file, whatever its command sets", async () => {
  process.env["SHIGOMORI_CD_FILE"] = "/tmp/not-a-directive";
  try {
    const script =
      'printf "%s %s" "${SHIGOMORI_CD_FILE-unset}" "${KEPT-unset}"';
    for (const options of [
      {},
      { env: { KEPT: "yes" }, extendEnv: true },
      {
        env: {
          KEPT: "yes",
          SHIGOMORI_CD_FILE: "/tmp/x",
          PATH: "/bin:/usr/bin",
        },
      },
    ]) {
      const said = await run(
        Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
          spawner.string(ChildProcess.make("/bin/sh", ["-c", script], options)),
        ),
      );
      assert.ok(Exit.isSuccess(said), String(said));
      assert.match(said.value, /^unset /);
    }
  } finally {
    delete process.env["SHIGOMORI_CD_FILE"];
  }
});
