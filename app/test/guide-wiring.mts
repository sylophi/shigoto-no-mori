// @vitest-environment happy-dom
// Proof that the two ways into the guide reach it through the window's
// own components (#950), mounted in a DOM over a fake page api: the
// sidebar footer's guide menu (SidebarFooter) lists this machine's
// agents and its item asks the shell's guide:start for the agent picked,
// and the Help menu's push (nav:showAround, which GuideMenu hears) asks
// the same. guide-menu.mts proves each piece apart; this fails when the
// footer stops drawing the menu or binds its pick elsewhere, or when
// GuideMenu hears another push or calls something else. What the footer
// draws beside the menu is stubbed: only the guide's wiring is real.
//
// Run: pnpm test guide-wiring.
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { GUIDE_QUESTION } from "@shigomori/contracts/modules/guide";
import { navContract } from "@shigomori/contracts/modules/nav";
import { afterEach, it, vi } from "vitest";
import { ApiProvider, type RendererApi } from "@/lib/runtime/pageApi";

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => () => {},
}));
vi.mock("@/hooks/ui/useKeymap", () => ({
  useBinding: () => ({ aria: undefined, label: null }),
}));
vi.mock("@/hooks/config/useSidebarMarks", () => ({
  useMarkAgentsWaiting: () => false,
}));
vi.mock("@/hooks/live/useLiveActivity", () => ({ useLiveCount: () => 0 }));
vi.mock("@/hooks/projects/useSidebarView", () => ({
  useSidebarView: () => "projects",
  useSetSidebarView: () => ({ mutate: () => {} }),
}));
vi.mock("@/hooks/system/useUpdater", () => ({ useStagedUpdates: () => ({}) }));
vi.mock("@/lib/agentWatch", () => ({ useWaitingAgents: () => [] }));
vi.mock("@/lib/localHost", () => ({ useHasLocalHost: () => true }));

// React's act, without its warning that the place isn't set up for it.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { SidebarFooter } = await import("@/components/sidebar/SidebarFooter");
const { GuideMenu } = await import("@/components/guide/GuideMenu");

// The page api as the window's shell and host serve it, with what was
// asked of it: the agents set up here, the calls run, and a way to push
// to the window.
function fakeApi() {
  const ran: unknown[] = [];
  const listeners = new Map<unknown, (payload: unknown) => void>();
  // oxlint-disable-next-line shigomori/no-double-cast -- the footer and GuideMenu read only these of the page's api
  const api = {
    deviceId: "guide-wiring",
    agents: { status: () => ({ call: "agents:status" }) },
    guide: { start: (input: unknown) => ({ call: "guide:start", input }) },
    menu: {
      setGuideHarnesses: (input: unknown) => ({
        call: "menu:setGuideHarnesses",
        input,
      }),
    },
    pushes: (contract: unknown, key: string) => ({ contract, key }),
    listen: (source: unknown, on: (payload: unknown) => void) => {
      listeners.set(source, on);
      return () => listeners.delete(source);
    },
    run: (call: { call: string }) => {
      ran.push(call);
      return Promise.resolve(
        call.call === "agents:status"
          ? [
              { id: "claude", detected: true },
              { id: "codex", detected: true },
            ]
          : undefined,
      );
    },
  } as unknown as RendererApi;
  const push = (contract: unknown, key: string, payload: unknown) => {
    for (const [source, on] of listeners) {
      const { contract: c, key: k } = source as {
        contract: unknown;
        key: string;
      };
      if (c === contract && k === key) on(payload);
    }
  };
  const asked = (name: string) =>
    ran.flatMap((call) => {
      const { call: called, input } = call as { call: string; input: unknown };
      return called === name ? [input] : [];
    });
  return {
    api,
    push,
    starts: () => asked("guide:start"),
    menus: () => asked("menu:setGuideHarnesses"),
  };
}

let unmount: (() => void) | undefined;
afterEach(() => {
  act(() => unmount?.());
  unmount = undefined;
  document.body.innerHTML = "";
});

async function mount(api: RendererApi) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  unmount = () => {
    root.unmount();
    client.clear();
  };
  await act(async () => {
    root.render(
      createElement(
        ApiProvider,
        { api },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            Fragment,
            null,
            createElement(SidebarFooter, {
              arrangeMode: false,
              onToggleArrange: () => {},
            }),
            createElement(GuideMenu),
          ),
        ),
      ),
    );
  });
}

// Settles what the clicks and the reads set going.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

it("the sidebar's guide menu starts the agent picked", async () => {
  const { api, starts } = fakeApi();
  await mount(api);
  await settle();
  const trigger = document.querySelector<HTMLElement>(
    `[aria-label="${GUIDE_QUESTION}"]`,
  );
  assert.ok(trigger, "the footer draws the guide menu");
  await act(async () => trigger.click());
  await settle();
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((el) => el.textContent?.trim() === "Codex");
  assert.ok(item, "the menu lists the agents set up here");
  await act(async () => item.click());
  await settle();
  assert.deepEqual(starts(), [{ harness: "codex" }]);
});

it("the Help menu's push starts its agent, and the menu hears this machine's agents", async () => {
  const { api, push, starts, menus } = fakeApi();
  await mount(api);
  await settle();
  assert.deepEqual(menus(), [["claude", "codex"]]);
  // The second agent, so a listener that starts a fixed one fails.
  await act(async () => push(navContract, "showAround", "codex"));
  await settle();
  assert.deepEqual(starts(), [{ harness: "codex" }]);
});
