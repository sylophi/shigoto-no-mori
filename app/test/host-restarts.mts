// Proof of the shell's account of its host's unasked exits
// (main/core/host/restarts.ts):
//   - a host is started again up to three times a minute, and given up
//     on at the fourth; a crash older than the minute no longer counts,
//     and a Retry from the migration's page starts the budget afresh.
//
// Run: pnpm test host-restarts.
import assert from "node:assert/strict";
import { it } from "vitest";
import { CRASH_WINDOW_MS, restartLedger } from "../main/core/host/restarts.ts";

it("three exits a minute start the host again, the fourth gives up, and an old one no longer counts", () => {
  const restarts = restartLedger();
  for (const at of [0, 10, 20]) {
    assert.deepEqual(restarts.exited(at), { kind: "restart" });
  }
  assert.deepEqual(restarts.exited(30), {
    kind: "give-up",
    crashes: 4,
  });

  const edge = restartLedger();
  for (const at of [0, 10, 20]) edge.exited(at);
  assert.deepEqual(
    edge.exited(CRASH_WINDOW_MS),
    { kind: "give-up", crashes: 4 },
    "a crash a minute old to the millisecond no longer counts",
  );

  const later = restartLedger();
  for (const at of [0, 10, 20]) later.exited(at);
  assert.deepEqual(later.exited(CRASH_WINDOW_MS + 1), {
    kind: "restart",
  });

  const retried = restartLedger();
  for (const at of [0, 10, 20]) retried.exited(at);
  retried.retried();
  assert.deepEqual(retried.exited(30), { kind: "restart" });
});
