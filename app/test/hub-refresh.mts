// Durable proof that every account report from the shell reconciles
// the hub socket (host/process/handlers.ts applyAccount), not only a
// change of account, hub or web origin: a device enrolled again under
// the same account (the blocked banner's Retry enrollment) holds a new
// credential and device key, which only a refresh hands the hub socket,
// and a blocked socket restarts only on a refresh. The refresh itself
// (wires.ts) is stood in: what it does with unchanged inputs is
// hub-link.mts's.
//
// Run: pnpm test hub-refresh.
import assert from "node:assert/strict";
import { it, vi } from "vitest";
import type { AccountFacts } from "@shigomori/contracts/modules/session";

const refreshed = vi.hoisted(() => ({ count: 0 }));
const stored = vi.hoisted(() => ({ facts: null as unknown }));

vi.mock("@host/process/wires", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshHubConnection: async () => {
    refreshed.count += 1;
  },
}));
vi.mock("@host/process/account", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setAccountFacts: async (next: unknown) => {
    const previous = stored.facts;
    stored.facts = next;
    return previous;
  },
}));

const { applyAccount } = await import("@host/process/handlers");

const facts = (credential: string, deviceKey: string): AccountFacts => ({
  hubUrl: "https://hub.test",
  accountId: "acct",
  credential,
  deviceKey,
  webOrigin: "https://web.test",
  acceptsCommands: false,
});

it("a device enrolled again under the same account reconciles its hub socket", async () => {
  await applyAccount(facts("first", "key-1"));
  assert.equal(refreshed.count, 1, "the first report connects");
  await applyAccount(facts("second", "key-2"));
  assert.equal(
    refreshed.count,
    2,
    "a new credential and key under the same account never reached the hub socket",
  );
});
