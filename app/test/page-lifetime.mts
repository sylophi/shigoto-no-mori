// Proof that what the boot starts outside React ends with the page
// (renderer/boot.tsx's `page`): the hosts' sweep requests stop hearing
// focus before the page's registry is disposed, so a page going (a
// full-page navigation, which fires `visibilitychange` to hidden after
// `pagehide`) reads no disposed registry.
//
// Run: pnpm test page-lifetime.
import assert from "node:assert/strict";
import { focusManager } from "@tanstack/react-query";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterAll, it, vi } from "vitest";
import { startRemoteSweepRequests } from "@/lib/remote/remoteSweep";

vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", {
  hasFocus: () => true,
  visibilityState: "visible",
});
afterAll(() => vi.unstubAllGlobals());

it("the sweep's focus listener ends before the registry they read is disposed", () => {
  const registry = AtomRegistry.make();
  const page = new AbortController();
  startRemoteSweepRequests(registry, page.signal);
  focusManager.setFocused(true);

  page.abort();
  registry.dispose();
  assert.doesNotThrow(() => focusManager.setFocused(false));
  focusManager.setFocused(undefined);
});
