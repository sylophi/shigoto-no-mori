// What a client makes of a peer's answers (shared/ipc/buildClient.ts):
// on a remote transport every result and push is decoded with the
// call's schema, so a malformed result rejects the call and a malformed
// push is dropped. A local transport hands values through as before.
//
// covers: app/shared/ipc/transport.ts
import assert from "node:assert/strict";
import * as Schema from "effect/Schema";
import {
  broadcast,
  defineContract,
  invoke,
} from "@shigomori/contracts/contract";
import { buildClient } from "@shared/ipc/buildClient";
import type { ClientTransport } from "@shared/ipc/transport";
import { it } from "vitest";

const probeContract = defineContract(
  "probe",
  "host",
  invoke("count", Schema.Void, Schema.Struct({ count: Schema.Int }), {
    remote: true,
    gated: false,
  }),
  broadcast("ticked", Schema.Struct({ at: Schema.Int }), { remote: true }),
);

// A transport answering every invoke with `answer` and pushing each of
// `pushes` to a subscriber at once.
function wire(
  answer: unknown,
  pushes: unknown[],
  remote: boolean,
): ClientTransport {
  return {
    remote,
    invoke: () => Promise.resolve(answer),
    subscribe: (_channel, handler) => {
      for (const push of pushes) handler(push);
      return () => {};
    },
  };
}

it("a remote client decodes results: a good one resolves, a malformed one rejects", async () => {
  const good = buildClient(probeContract, wire({ count: 2 }, [], true));
  assert.deepEqual(await good.count(), { count: 2 });
  const bad = buildClient(probeContract, wire({ count: "two" }, [], true));
  await assert.rejects(bad.count());
});

it("a remote client drops a push that does not decode", () => {
  const client = buildClient(
    probeContract,
    wire(null, [{ at: 1 }, { at: "late" }, { at: 3 }], true),
  );
  const seen: unknown[] = [];
  client.onTicked((payload) => seen.push(payload));
  assert.deepEqual(seen, [{ at: 1 }, { at: 3 }]);
});

it("a local client hands values through as they are", async () => {
  const client = buildClient(
    probeContract,
    wire({ count: "two" }, [{ at: "late" }], false),
  );
  assert.deepEqual(await client.count(), { count: "two" });
  const seen: unknown[] = [];
  client.onTicked((payload) => seen.push(payload));
  assert.deepEqual(seen, [{ at: "late" }]);
});
