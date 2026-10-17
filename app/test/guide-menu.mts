// Proof for the two ways into the guide, the Help menu's items
// (main/electron/menu.ts) and the sidebar's guide menu
// (SidebarGuideMenuView, bound in SidebarFooter.tsx):
//   - the Help menu has an item for each agent installed here, named
//     "Ask <agent> about the app", which pushes its agent to the window
//     it was clicked in, and none with no agent,
//   - the sidebar's menu says what it is for and lists each agent by
//     name, one agent too, and an item picks its agent,
//   - both end in the one launch, the shell's guide:start for that
//     agent (startGuide).
//
// Run: pnpm test guide-menu.
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MenuItemConstructorOptions } from "electron";
import {
  GUIDE_QUESTION,
  type GuideHarness,
} from "@shigomori/contracts/modules/guide";
import { navContract } from "@shigomori/contracts/modules/nav";
import { StaticMenu } from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { SidebarGuideMenuItemsView } from "@shigomori/ui/views/sidebar/SidebarFooterView.tsx";
import type { HandlerContext } from "@shared/ipc/transport";
import { it, vi } from "vitest";
import { startGuide } from "@/hooks/useGuide";
import type { RendererApi } from "@/lib/runtime/pageApi";

type Template = MenuItemConstructorOptions[];
let appMenu: Template = [];
const pushes: unknown[][] = [];

vi.mock("electron", () => ({
  app: { name: "Shigoto no Mori", isPackaged: true },
  Menu: {
    buildFromTemplate: (template: Template) => ({ template }),
    setApplicationMenu: (menu: { template: Template }) => {
      appMenu = menu.template;
    },
  },
}));
vi.mock("../main/electron/clientConfig", () => ({
  readClientConfigSync: () => ({}),
}));
vi.mock("../main/ipc/register", () => ({
  broadcast: (module: unknown, key: string, payload: unknown, to: unknown) =>
    pushes.push([module, key, payload, to]),
}));
vi.mock("../main/electron/windows", () => ({ openWindow: () => {} }));

const { installMenuImpl, noteMenuWindowFocused } =
  await import("../main/electron/menu");
const { menuHandlers } = await import("../main/ipc/modules/menu");

installMenuImpl();
noteMenuWindowFocused(7);
const contents = { id: 7 };

const helpItems = (harnesses: GuideHarness[]): Template => {
  menuHandlers.setGuideHarnesses(harnesses, {
    windowId: 7,
  } as HandlerContext);
  const help = appMenu.find((item) => item.role === "help");
  return (help?.submenu ?? []) as Template;
};

it("names an item for each agent in the Help menu, which pushes its agent to the window", () => {
  const items = helpItems(["claude", "codex"]);
  assert.deepEqual(
    items.map((item) => item.label),
    ["Ask Claude Code about the app", "Ask Codex about the app"],
  );
  for (const item of items) {
    item.click?.({} as never, { webContents: contents } as never, {} as never);
  }
  assert.deepEqual(pushes, [
    [navContract, "showAround", "claude", contents],
    [navContract, "showAround", "codex", contents],
  ]);
  assert.deepEqual(helpItems([]), []);
});

const menuMarkup = (harnesses: GuideHarness[]) =>
  renderToStaticMarkup(
    createElement(
      StaticMenu,
      null,
      createElement(SidebarGuideMenuItemsView, { harnesses, onPick: () => {} }),
    ),
  );

const itemNames = (markup: string) =>
  [...markup.matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map(
    ([, name]) => name,
  );

it("says what the sidebar's menu is for and names each agent, one agent too", () => {
  const two = menuMarkup(["claude", "codex"]);
  assert.ok(two.includes(`>${GUIDE_QUESTION}<`));
  assert.deepEqual(itemNames(two), ["Claude Code", "Codex"]);
  const one = menuMarkup(["codex"]);
  assert.ok(one.includes(`>${GUIDE_QUESTION}<`));
  assert.deepEqual(itemNames(one), ["Codex"]);
});

// The items as the view makes them, each with the click it binds.
const itemsOf = (element: ReactElement): ReactElement[] => {
  const children = (element.props as { children: unknown }).children;
  return (children as unknown[]).flat() as ReactElement[];
};

it("picks the agent of the item clicked in the sidebar's menu", () => {
  const picked: GuideHarness[] = [];
  const view = SidebarGuideMenuItemsView({
    harnesses: ["claude", "codex"],
    onPick: (harness) => picked.push(harness),
  });
  for (const item of itemsOf(view).slice(1)) {
    (item.props as { onClick: () => void }).onClick();
  }
  assert.deepEqual(picked, ["claude", "codex"]);
});

it("launches through the shell's guide:start for the agent picked", async () => {
  const started: unknown[] = [];
  const api = {
    guide: { start: (input: unknown) => input },
    run: async (call: unknown) => {
      started.push(call);
    },
  } as RendererApi;
  startGuide(api, "codex");
  await Promise.resolve();
  assert.deepEqual(started, [{ harness: "codex" }]);
});
