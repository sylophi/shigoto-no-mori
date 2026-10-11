// Durable proof for the packaged build's refusal of remote debugging
// (main/electron/debugSwitches.ts): either of Chromium's switches is
// asked for, and nothing else is.
//
// Run: pnpm test debug-switches.
import assert from "node:assert/strict";
import { it } from "vitest";
import { asksForRemoteDebugging } from "../main/electron/debugSwitches";

const on =
  (...switches: string[]) =>
  (name: string) =>
    switches.includes(name);

it("reads either remote debugging switch, and no other, as asked for", () => {
  assert.equal(asksForRemoteDebugging(on("remote-debugging-port")), true);
  assert.equal(asksForRemoteDebugging(on("remote-debugging-pipe")), true);
  assert.equal(asksForRemoteDebugging(on("use-mock-keychain")), false);
  assert.equal(asksForRemoteDebugging(on()), false);
});
