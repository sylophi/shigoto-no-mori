// Proof that what the boot starts outside React ends with the page
// (renderer/boot.tsx's `page`), before the page's registry is disposed:
// the hosts' sweep requests stop hearing focus, so a page going (a
// full-page navigation, which fires `visibilitychange` to hidden after
// `pagehide`) reads no disposed registry; and the agent watch stops
// hearing the worktree lists, whose ends the registry's own disposal
// announces as it stops their views, so it writes none.
//
// Run: pnpm test page-lifetime.
import assert from "node:assert/strict";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterAll, it, vi } from "vitest";
import { startAgentWatch } from "@/lib/agentWatch";
import { setWindowFocused } from "@/lib/focus";
import { startRemoteSweepRequests } from "@/lib/remote/remoteSweep";
import type { RendererApi } from "@/lib/runtime/pageApi";
import { noteWorktreeList } from "@/lib/viewFeed";

vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", {
  hasFocus: () => true,
  visibilityState: "visible",
});
afterAll(() => vi.unstubAllGlobals());

it("the sweep's focus listener ends before the registry it reads is disposed", () => {
  const registry = AtomRegistry.make();
  const page = new AbortController();
  startRemoteSweepRequests(registry, page.signal);
  setWindowFocused(true);

  page.abort();
  registry.dispose();
  assert.doesNotThrow(() => setWindowFocused(false));
});

it("the agent watch stops hearing the lists before the registry it writes is disposed", () => {
  const registry = AtomRegistry.make();
  const page = new AbortController();
  startAgentWatch({} as RendererApi, registry, page.signal);
  noteWorktreeList({ key: "w", deviceId: "d", list: [] });

  page.abort();
  registry.dispose();
  assert.doesNotThrow(() =>
    noteWorktreeList({ key: "w", deviceId: "d", list: null }),
  );
});
