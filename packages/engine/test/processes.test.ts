// A command run to its end, or past its deadline ended with it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { it } from "vitest";
import { CommandTimedOut, captureWithin } from "../src/processes.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
) => Effect.runPromise(Effect.exit(Effect.provide(effect, NodeServices.layer)));

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
