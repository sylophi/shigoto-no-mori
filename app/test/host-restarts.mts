// Proof of the shell's account of its host's unasked exits
// (main/core/host/restarts.ts):
//   - a host is started again up to three times a minute, and given up
//     on at the fourth; a crash older than the minute no longer counts,
//     and a Retry from the migration's page starts the budget afresh,
//   - the next host is told of the hosts that exited within the minute
//     before it, until one is up.
//
// Run: pnpm test host-restarts.
import assert from "node:assert/strict";
import { it } from "vitest";
import { CRASH_WINDOW_MS, restartLedger } from "../main/core/host/restarts.ts";

const host = (pid: number) => ({ pid, startedAt: 1_700_000_000_000 + pid });

it("three exits a minute start the host again, the fourth gives up, and an old one no longer counts", () => {
  const restarts = restartLedger();
  for (const at of [0, 10, 20]) {
    assert.deepEqual(restarts.exited(host(at), at), { kind: "restart" });
  }
  assert.deepEqual(restarts.exited(host(30), 30), {
    kind: "give-up",
    crashes: 4,
  });

  const edge = restartLedger();
  for (const at of [0, 10, 20]) edge.exited(host(at), at);
  assert.deepEqual(
    edge.exited(host(1), CRASH_WINDOW_MS),
    { kind: "give-up", crashes: 4 },
    "a crash a minute old to the millisecond no longer counts",
  );

  const later = restartLedger();
  for (const at of [0, 10, 20]) later.exited(host(at), at);
  assert.deepEqual(later.exited(host(1), CRASH_WINDOW_MS + 1), {
    kind: "restart",
  });

  const retried = restartLedger();
  for (const at of [0, 10, 20]) retried.exited(host(at), at);
  retried.retried();
  assert.deepEqual(retried.exited(host(30), 30), { kind: "restart" });
});

it("the next host is told of the hosts gone within the minute, until one is up", () => {
  const restarts = restartLedger();
  restarts.exited(host(1), 0);
  restarts.exited(undefined, 10);
  restarts.exited(host(2), 20);
  assert.deepEqual(restarts.replacesHosts(), [host(1), host(2)]);
  restarts.exited(host(3), CRASH_WINDOW_MS + 5);
  assert.deepEqual(
    restarts.replacesHosts(),
    [host(2), host(3)],
    "a host gone longer than the minute is vouched for",
  );
  restarts.up();
  assert.deepEqual(restarts.replacesHosts(), []);
});
