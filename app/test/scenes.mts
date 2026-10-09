// The scenes (lab/scenes): the app's views drawn over the lab's
// fixtures, which the marketing site renders at build time.
//
// Asserts:
//   1. Every scene renders to HTML in Node, where there is no window,
//      no app bridge, no router and no query client. That is a view's
//      contract (app/DESIGN.md, "Views and containers"): a view that
//      reaches for a hook that fetches, the router or window.api fails
//      here rather than in the marketing build.
//   2. Every view (an export named <Thing>View from a *View.tsx file
//      under renderer/components) is drawn by some scene.
//   3. A component file under renderer/components that isn't a view,
//      outside the ui/ primitives, has no markup of its own: it is a
//      container, binding data to views.
//
// covers: app/renderer/components/**
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { scenes } from "../lab/scenes/index.ts";
import { appRoot, stripComments, walk } from "./lib/checkKit.mts";

// The areas not split yet (V3.md, step 6) leave these lists as their
// PRs land. Two still hold a *View.tsx that is no view, which can't
// even load here.
type Component = (props: unknown) => unknown;
const views = import.meta.glob<Record<string, Component>>(
  [
    "../renderer/components/**/*View.tsx",
    "!../renderer/components/addProject/**",
    "!../renderer/components/diff/**",
  ],
  { eager: true },
);

const PENDING = [
  "AddProjectModal.tsx",
  "addProject/",
  "configure/",
  "convertExternal/",
  "diff/",
  "files/",
  "home/",
  "live/",
  "manageBranches/",
  "newWorktree/",
  "palette/",
  "remote/",
  "scriptConsole/",
  "settings/",
  "sidebar/",
  "tidy/",
  "villagers/",
  "visitors/",
  "worktreeDetail/",
  "worktreeLocation/",
];

// An intrinsic element opening (<div, <span ...>), not a type argument
// (useState<string>), which follows an identifier.
const MARKUP = /(?:^|[^\w$.])<([a-z][\w-]*)[\s/>]/m;

it("has no window", () => {
  expect((globalThis as { window?: unknown }).window).toBeUndefined();
});

it("renders every scene, and every view in one", () => {
  const drawn = new Map<string, number>();
  for (const [file, module] of Object.entries(views)) {
    for (const name of Object.keys(module)) {
      const real = module[name];
      if (!name.endsWith("View") || typeof real !== "function") {
        continue;
      }
      const path = file.replace("../renderer/components/", "");
      if (PENDING.some((area) => path.startsWith(area))) continue;
      const id = `${path}#${name}`;
      drawn.set(id, 0);
      vi.spyOn(module, name).mockImplementation((props: unknown) => {
        drawn.set(id, (drawn.get(id) ?? 0) + 1);
        return real(props);
      });
    }
  }
  for (const [name, { Scene }] of Object.entries(scenes)) {
    const html = renderToStaticMarkup(createElement(Scene));
    assert.ok(html.length > 0, `${name} rendered nothing`);
    assert.ok(!html.includes("NaN"), `${name} rendered a NaN`);
  }
  const undrawn = [...drawn].filter(([, n]) => n === 0).map(([id]) => id);
  expect(undrawn, "views no scene draws").toEqual([]);
});

it("keeps markup out of containers", () => {
  const root = join(appRoot, "renderer", "components");
  const offenders: string[] = [];
  for (const file of walk(root, /\.tsx$/)) {
    const path = relative(root, file);
    if (path.startsWith("ui/") || path.endsWith("View.tsx")) continue;
    if (PENDING.some((area) => path.startsWith(area))) continue;
    const tag = MARKUP.exec(stripComments(readFileSync(file, "utf8")));
    if (tag) offenders.push(`${path} <${tag[1]}>`);
  }
  expect(offenders, "containers with markup").toEqual([]);
});
