// Proof that this machine's host coming back is told and read once,
// whatever the window's own asks went through
// (renderer/lib/runtime/hostAnswering.ts):
//   - the band says a restart the window lived through, its baseline
//     the shell's count as the window opened, asked until the shell
//     answers and before any landing's, so a first ask that failed no
//     longer makes the next landing's count the baseline and the
//     restart unsaid (followHostRestarts),
//   - the reads the host's going cut are asked again as it answers once
//     more, one that gave up and one still in its retries alike
//     (askAgainOnHostReturn).
//
// Run: pnpm test host-return.
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { it } from "vitest";
import { RemoteDisconnectedError } from "@shared/remote/rpcTransport";
import {
  askAgainOnHostReturn,
  followHostRestarts,
  hostAnswering,
  hostRestarted,
} from "@/lib/runtime/hostAnswering";
import { testClock, waitFor } from "./lib/checkKit.mts";

const SILENT = { kind: "silent" as const, seconds: 30 };
const drop = () => new RemoteDisconnectedError(true);

it("a restart is said though the window's first ask of the count failed", async () => {
  const clock = testClock();
  // The shell's count: the first ask fails (the port not yet up), the
  // next answer the count as the window opened, then one restart.
  const answers: (number | Error)[] = [new Error("not yet"), 2, 3];
  const ask = Effect.suspend(() => {
    const next = answers.shift() ?? 3;
    return typeof next === "number"
      ? Effect.succeed({ count: next, reason: SILENT })
      : Effect.fail(next);
  });
  hostRestarted.publish(null);
  const restarts = await Effect.runPromise(
    followHostRestarts(ask).pipe(Effect.provide(clock.context)),
  );
  const baseline = Effect.runFork(
    restarts.baseline.pipe(Effect.provide(clock.context)),
  );
  // A landing asked while the baseline waits on its retry waits its turn.
  const landed = Effect.runFork(
    restarts.landed.pipe(Effect.provide(clock.context)),
  );
  await clock.advance(1_000);
  await Effect.runPromise(Fiber.join(baseline));
  await Effect.runPromise(Fiber.join(landed));
  assert.deepEqual(hostRestarted.get(), { reason: SILENT });
});

it("the reads the host's going cut are asked again as it answers", async () => {
  const client = new QueryClient();
  const reads = { gaveUp: 0, retrying: 0 };
  const gaveUp = new QueryObserver(client, {
    queryKey: ["gave-up"],
    queryFn: async () => {
      reads.gaveUp += 1;
      if (reads.gaveUp === 1) throw drop();
      return reads.gaveUp;
    },
    retry: false,
  });
  const retrying = new QueryObserver(client, {
    queryKey: ["retrying"],
    queryFn: async () => {
      reads.retrying += 1;
      if (reads.retrying === 1) throw drop();
      return reads.retrying;
    },
    retry: true,
    // Its next try would be an hour out: only the host's return asks.
    retryDelay: 3_600_000,
  });
  const stops = [gaveUp.subscribe(() => {}), retrying.subscribe(() => {})];
  const page = new AbortController();
  hostAnswering.publish(false);
  askAgainOnHostReturn(client, page.signal);
  await waitFor(
    () => reads.gaveUp === 1 && reads.retrying === 1,
    "both reads cut",
  );

  hostAnswering.publish(true);
  await waitFor(
    () => reads.gaveUp === 2 && reads.retrying === 2,
    "both reads asked again",
  );
  page.abort();
  for (const stop of stops) stop();
  client.clear();
});
