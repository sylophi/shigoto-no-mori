// Durable proof that a refusal names the machine that refused and the
// switch on it: an action a peer turned away toasts "Read-only until
// <its name> turns on “Allow control from other devices” on its account
// page", with the name the window's registry has for it.
//
// Run: pnpm test consent-words.
import assert from "node:assert/strict";
import { it, vi } from "vitest";
import { CommandRefusedError } from "@shigomori/contracts/errors";
import { createAppQueryClient } from "@/lib/queryClientOptions";

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
