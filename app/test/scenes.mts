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

// Every function component the scenes render, recorded through the JSX
// runtime the compiled views call: it hands React a wrapper for each,
// made once so the type stays the same element to element, which notes
// the render. So a view counts however it is reached (from another
// file, or from a sibling in its own), and only once it is drawn, not
// when an element for it is made and left unused.
const drawn = vi.hoisted(() => new Set<unknown>());
const recording = vi.hoisted(() => {
  const wrappers = new WeakMap<object, unknown>();
  const wrap = (type: unknown): unknown => {
    // A class component is no function to call, and an arrow has no
    // prototype to tell by.
    if (
      typeof type !== "function" ||
      (type.prototype as { isReactComponent?: unknown } | undefined)
        ?.isReactComponent !== undefined
    ) {
      return type;
    }
    let wrapper = wrappers.get(type);
    if (wrapper === undefined) {
      const render = type as (props: unknown) => unknown;
      wrapper = (props: unknown) => {
        drawn.add(type);
        return render(props);
      };
      wrappers.set(type, wrapper);
    }
    return wrapper;
  };
  return async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const real = await importOriginal();
    const record =
      (create: unknown) =>
      (type: unknown, ...rest: unknown[]) =>
        (create as (...args: unknown[]) => unknown)(wrap(type), ...rest);
    return {
      ...real,
      jsx: record(real["jsx"]),
      jsxs: record(real["jsxs"]),
      jsxDEV: record(real["jsxDEV"]),
    };
  };
});
vi.mock("react/jsx-runtime", recording);
vi.mock("react/jsx-dev-runtime", recording);

// The areas not split yet (V3.md, step 6) leave these lists as their
// PRs land. Two still hold a *View.tsx that is no view, which can't
// even load here.
const views = import.meta.glob<Record<string, unknown>>(
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
  "scriptConsole/",
  "tidy/",
  "worktreeLocation/",
];

// An intrinsic element opening (<div, <span ...>), not a type argument
// (useState<string>), which follows an identifier.
const MARKUP = /(?:^|[^\w$.])<([a-z][\w-]*)[\s/>]/m;

it("has no window", () => {
  expect((globalThis as { window?: unknown }).window).toBeUndefined();
});

it("renders every scene, and every view in one", () => {
  for (const [name, { Scene }] of Object.entries(scenes)) {
    const html = renderToStaticMarkup(createElement(Scene));
    assert.ok(html.length > 0, `${name} rendered nothing`);
    assert.ok(!html.includes("NaN"), `${name} rendered a NaN`);
  }
  const undrawn: string[] = [];
  for (const [file, module] of Object.entries(views)) {
    const path = file.replace("../renderer/components/", "");
    if (PENDING.some((area) => path.startsWith(area))) continue;
    for (const [name, value] of Object.entries(module)) {
      if (!name.endsWith("View") || typeof value !== "function") continue;
      if (!drawn.has(value)) undrawn.push(`${path}#${name}`);
    }
  }
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
