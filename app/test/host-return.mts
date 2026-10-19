// Proof that this machine's host coming back is told and read once,
// whatever the window's own asks went through
// (renderer/lib/runtime/hostAnswering.ts):
//   - the band says each restart the shell tells once the window's
//     link lands on the new host, and once, and none in a window that
//     opened while the host was away (followHostRestarts),
//   - the reads the host's going cut are asked again as it answers once
//     more, one that gave up and one still in its retries alike
//     (askAgainOnHostReturn).
//
// Run: pnpm test host-return.
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { HostRestartReason } from "@shigomori/ui/views/hostBand/HostBandView.tsx";
import { it } from "vitest";
import { RemoteDisconnectedError } from "@shared/remote/rpcTransport";
import {
  askAgainOnHostReturn,
  followHostRestarts,
  hostAnswering,
  hostRestarted,
} from "@/lib/runtime/hostAnswering";
import { waitFor } from "./lib/checkKit.mts";

const SILENT: HostRestartReason = { kind: "silent", seconds: 30 };
const EXITED: HostRestartReason = { kind: "exited", code: 1 };
const drop = () => new RemoteDisconnectedError(true);

it("a restart is said once the window's link lands on the new host, and not in a window that opened in the gap", async () => {
  const pushes = await Effect.runPromise(Queue.unbounded<HostRestartReason>());
  const restarts = followHostRestarts(Stream.fromQueue(pushes));
  const heard = Effect.runFork(restarts.heard);
  hostRestarted.publish(null);
  // Opened while the host was away: its link has not landed yet.
  Queue.offerUnsafe(pushes, EXITED);
  await waitFor(() => Queue.sizeUnsafe(pushes) === 0, "the word heard");
  restarts.landed();
  assert.equal(
    hostRestarted.get(),
    null,
    "said in a window that opened in the gap",
  );
  hostAnswering.publish(false);
  Queue.offerUnsafe(pushes, SILENT);
  await waitFor(() => Queue.sizeUnsafe(pushes) === 0, "the word heard");
  assert.equal(hostRestarted.get(), null, "said while the host is away");
  restarts.landed();
  assert.deepEqual(hostRestarted.get(), { reason: SILENT });
  hostRestarted.publish(null);
  restarts.landed();
  assert.equal(hostRestarted.get(), null, "said twice");
  // The word came before the window saw its link drop.
  hostAnswering.publish(true);
  Queue.offerUnsafe(pushes, EXITED);
  await waitFor(() => hostRestarted.get() !== null, "the word said");
  assert.deepEqual(hostRestarted.get(), { reason: EXITED });
  await Effect.runPromise(Fiber.interrupt(heard));
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
    () =>
      client.getQueryState(["gave-up"])?.status === "error" &&
      client.getQueryState(["retrying"])?.fetchFailureReason != null,
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
