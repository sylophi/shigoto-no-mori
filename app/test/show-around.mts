// Proof that the sidebar's guide button (menu:showAround) does what the
// Help menu's guide item does (main/electron/menu.ts):
//   - with one harness, the same push to the calling window as the
//     item's click,
//   - with several, the Help menu's very items, popped up where the
//     button is, each pushing what its Help item pushes,
//   - with none, nothing, as the Help menu offers nothing.
//
// Run: pnpm test show-around.
import assert from "node:assert/strict";
import type { MenuItemConstructorOptions } from "electron";
import type { GuideHarness } from "@shigomori/contracts/modules/guide";
import { navContract } from "@shigomori/contracts/modules/nav";
import type { HandlerContext } from "@shared/ipc/transport";
import { beforeEach, it, vi } from "vitest";

type Template = MenuItemConstructorOptions[];
let appMenu: Template = [];
const popups: { template: Template; at: unknown }[] = [];
const pushes: unknown[][] = [];

vi.mock("electron", () => ({
  app: { name: "Shigoto no Mori", isPackaged: true },
  Menu: {
    buildFromTemplate: (template: Template) => ({
      template,
      popup: (at: unknown) => popups.push({ template, at }),
    }),
    setApplicationMenu: (menu: { template: Template }) => {
      appMenu = menu.template;
    },
  },
  BrowserWindow: {
    fromWebContents: (webContents: unknown) => ({ webContents }),
  },
}));
vi.mock("../main/electron/clientConfig", () => ({
  readClientConfigSync: () => ({}),
}));
vi.mock("../main/ipc/register", () => ({
  broadcast: (module: unknown, key: string, payload: unknown, to: unknown) =>
    pushes.push([module, key, payload, to]),
}));
const contents = { id: 7 };
vi.mock("../main/electron/windows", () => ({
  liveWindow: (windowId: number) =>
    windowId === 7 ? { webContents: contents, route: "/" } : undefined,
  openWindow: () => {},
}));

const { installMenuImpl, noteMenuWindowFocused } =
  await import("../main/electron/menu");
const { menuHandlers } = await import("../main/ipc/modules/menu");

const caller = { windowId: 7 } as HandlerContext;
installMenuImpl();
noteMenuWindowFocused(7);

const offer = (harnesses: GuideHarness[]) =>
  menuHandlers.setGuideHarnesses(harnesses, caller);

const helpItems = (): MenuItemConstructorOptions[] => {
  const help = appMenu.find((item) => item.role === "help");
  return (help?.submenu ?? []) as MenuItemConstructorOptions[];
};

// A click as Electron makes it, in the focused window.
const click = (item: MenuItemConstructorOptions) => {
  const before = pushes.length;
  item.click?.({} as never, { webContents: contents } as never, {} as never);
  return pushes.slice(before);
};

const showAround = () => {
  const before = pushes.length;
  menuHandlers.showAround({ x: 12.4, y: 300.6 }, caller);
  return pushes.slice(before);
};

beforeEach(() => {
  popups.length = 0;
});

it("opens the one harness with the Help item's push", () => {
  offer(["claude"]);
  const [item] = helpItems();
  assert.ok(item);
  const fromMenu = click(item);
  assert.deepEqual(fromMenu, [[navContract, "showAround", "claude", contents]]);
  assert.deepEqual(showAround(), fromMenu);
  assert.equal(popups.length, 0);
});

it("offers several harnesses as the Help menu's own items, at the button", () => {
  offer(["claude", "codex"]);
  assert.deepEqual(showAround(), []);
  assert.equal(popups.length, 1);
  const [{ template, at }] = popups as [(typeof popups)[number]];
  assert.deepEqual(at, { window: { webContents: contents }, x: 12, y: 301 });
  const help = helpItems();
  assert.deepEqual(
    template.map((item) => item.label),
    help.map((item) => item.label),
  );
  for (const [i, item] of template.entries()) {
    const fromHelp = help[i];
    assert.ok(fromHelp);
    assert.deepEqual(click(item), click(fromHelp));
  }
});

it("does nothing with no harness, as the Help menu offers none", () => {
  offer([]);
  assert.equal(helpItems().length, 0);
  assert.deepEqual(showAround(), []);
  assert.equal(popups.length, 0);
});
