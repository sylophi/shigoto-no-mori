// Durable proof that a refusal names the machine that refused and the
// switch on it: an action a peer turned away toasts "Read-only until
// <its name> turns on “Allow control from other devices” on its account
// page", with the name the window's registry has for it, which the
// end that asked fills in (this host's peer calls, the window's peer
// api).
//
// Run: pnpm test consent-words.
import assert from "node:assert/strict";
import { it, vi } from "vitest";
import { CommandRefusedError } from "@shigomori/contracts/errors";
import { createAppQueryClient } from "@/lib/queryClientOptions";
import * as Effect from "effect/Effect";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { make as makePeerReach } from "@host/ipc/PeerReach";

const toasts: string[] = [];
vi.mock("@/lib/toast", () => ({
  notifyError: (title: string) => toasts.push(title),
}));

const refusedBy = async (error: CommandRefusedError) => {
  toasts.length = 0;
  const client = createAppQueryClient((deviceId) =>
    deviceId === "kiwi" ? "Kiwi IV" : undefined,
  );
  await client
    .getMutationCache()
    .build(client, {
      mutationFn: async () => {
        throw error;
      },
      // A refusal is said ahead of a mutation's own opt-out.
      meta: { silentError: true },
    })
    .execute(undefined)
    .catch(() => {});
  return toasts;
};

it("an action a peer refused names that peer and the switch on its account page", async () => {
  assert.deepEqual(
    await refusedBy(new CommandRefusedError({ deviceId: "kiwi" })),
    [
      "Read-only until Kiwi IV turns on “Allow control from other devices” on its account page.",
    ],
  );
});

it("a peer the registry no longer knows reads as the other device", async () => {
  assert.deepEqual(
    await refusedBy(new CommandRefusedError({ deviceId: "gone" })),
    [
      "Read-only until the other device turns on “Allow control from other devices” on its account page.",
    ],
  );
});

it("a refusal reached through this host's peer calls names the peer, for the window's toast", async () => {
  const reach = makePeerReach({
    transportFor: () => ({
      invoke: () => Promise.reject(new CommandRefusedError()),
      subscribe: () => () => {},
    }),
    channelsFor: () => () => Promise.reject(new Error("no channels")),
  });
  const refusal = await Effect.runPromise(
    Effect.flip(
      reach.calls(worktreesContract, "kiwi").list({ projectId: "p" }),
    ),
  );
  assert.ok(refusal instanceof CommandRefusedError);
  assert.equal(refusal.deviceId, "kiwi");
});
