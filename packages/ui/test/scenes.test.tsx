// The scenes (src/scenes): the views drawn over the fixtures, which the
// marketing site renders at build time and the lab's scene viewer shows.
//
// Asserts:
//   1. Every scene renders to HTML in Node, where there is no window,
//      no app bridge, no router and no query client. That is a view's
//      contract (app/DESIGN.md, "Views and containers"): a view that
//      reaches for a hook that fetches, the router or window.api fails
//      here rather than in the marketing build.
//   2. Every view (an export named <Thing>View from a *View.tsx file
//      under src/views) is drawn by some scene.
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { scenes } from "../src/scenes/index.ts";

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

const views = import.meta.glob<Record<string, unknown>>(
  "../src/views/**/*View.tsx",
  { eager: true },
);

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
    const path = file.replace("../src/views/", "");
    for (const [name, value] of Object.entries(module)) {
      if (!name.endsWith("View") || typeof value !== "function") continue;
      if (!drawn.has(value)) undrawn.push(`${path}#${name}`);
    }
  }
  expect(undrawn, "views no scene draws").toEqual([]);
});
