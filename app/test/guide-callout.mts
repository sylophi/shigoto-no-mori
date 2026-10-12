// Durable proof for the guide's callout following its target through a
// re-render (renderer/lib/guideTarget.ts, which GuideCallout.tsx runs).
//
// Asserts: a control re-rendered into a new element is the same control
// (its tag, role, label, the text of what labels it or its own labels,
// link and text,
// whitespace aside, and not the ids a remount draws anew), so the callout finds the replacement after the
// shell's mark went with the old one. Of two of one name, the one nearest
// where the last stood is kept. A control the page no longer has, or one
// whose text changed, is not found, so the ring goes rather than moving
// to something else.
//
// Run: pnpm test guide-callout.
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  type TargetLike,
  refindTarget,
  targetKey,
} from "../renderer/lib/guideTarget.ts";

type Fake = TargetLike & { readonly label: string };

// The page's labels by id, which aria-labelledby names.
const labels = new Map<string, string>();
const doc = {
  getElementById: (id: string) => {
    const text = labels.get(id);
    return text === undefined ? null : { textContent: text };
  },
};

// An element as the page draws it: a tag, attributes, text and a box.
function el(
  label: string,
  tagName: string,
  attributes: Record<string, string>,
  text: string,
  box: { x: number; y: number } = { x: 0, y: 0 },
): Fake {
  return {
    label,
    tagName,
    textContent: text,
    getAttribute: (name) => attributes[name] ?? null,
    ownerDocument: doc,
    getBoundingClientRect: () => ({
      left: box.x,
      top: box.y,
      width: 100,
      height: 20,
    }),
  };
}

const page = (...elements: Fake[]) => ({
  querySelectorAll: (tag: string) => elements.filter((e) => e.tagName === tag),
});

it("finds a re-rendered row again, ids aside, and nothing once it is gone", () => {
  const before = el(
    "before",
    "A",
    { href: "/wt/brewster", id: "r1", "aria-labelledby": "r1-label" },
    "brewster\n   brewster",
    { x: 10, y: 100 },
  );
  const key = targetKey(before);
  const after = el(
    "after",
    "A",
    { href: "/wt/brewster", id: "r7", "aria-labelledby": "r7-label" },
    "brewster brewster",
    { x: 10, y: 100 },
  );
  const other = el("main", "A", { href: "/wt/main" }, "main main", {
    x: 10,
    y: 50,
  });
  assert.equal(
    refindTarget(page(other, after), key, { x: 60, y: 110 })?.label,
    "after",
  );
  assert.equal(refindTarget(page(other), key, { x: 60, y: 110 }), null);
});

it("keeps the nearest of two controls of one name", () => {
  const near = { x: 1700, y: 890 };
  const pointed = el("pointed", "BUTTON", {}, "Add port", {
    x: 1650,
    y: 880,
  });
  const key = targetKey(pointed);
  const far = el("far", "BUTTON", {}, "Add port", { x: 600, y: 300 });
  const kept = el("kept", "BUTTON", {}, "Add port", { x: 1650, y: 880 });
  assert.equal(refindTarget(page(far, kept), key, near)?.label, "kept");
});

it("tells switches named only by their labels apart, through a remount", () => {
  labels.set("a1", "Doubutsu theme");
  labels.set("b1", "Clone files from an existing checkout");
  const pointed = el(
    "doubutsu",
    "BUTTON",
    { role: "switch", "aria-labelledby": "a1" },
    "",
  );
  const key = targetKey(pointed);
  const other = el(
    "clone",
    "BUTTON",
    { role: "switch", "aria-labelledby": "b1" },
    "",
  );
  assert.equal(refindTarget(page(other), key, { x: 0, y: 0 }), null);
  // Remounted, its label drawn under a new id.
  labels.set("a2", "Doubutsu theme");
  const again = el(
    "again",
    "BUTTON",
    { role: "switch", "aria-labelledby": "a2" },
    "",
  );
  assert.equal(
    refindTarget(page(other, again), key, { x: 0, y: 0 })?.label,
    "again",
  );
});

it("tells fields apart by their own labels", () => {
  const field = (label: string, text: string) => ({
    ...el(label, "INPUT", {}, ""),
    labels: [{ textContent: text }],
  });
  const key = targetKey(field("branch", "Branch name"));
  assert.equal(
    refindTarget(page(field("folder", "Worktree folder")), key, { x: 0, y: 0 }),
    null,
  );
  assert.equal(
    refindTarget(page(field("again", "Branch name")), key, { x: 0, y: 0 })
      ?.label,
    "again",
  );
});

it("tells controls apart by tag, role, label and text", () => {
  const button = el("button", "BUTTON", { "aria-label": "Stop" }, "");
  const key = targetKey(button);
  const candidates = page(
    el("link", "A", { "aria-label": "Stop" }, ""),
    el("tab", "BUTTON", { "aria-label": "Stop", role: "tab" }, ""),
    el("start", "BUTTON", { "aria-label": "Start" }, ""),
    el("texted", "BUTTON", { "aria-label": "Stop" }, "Stop now"),
  );
  assert.equal(refindTarget(candidates, key, { x: 0, y: 0 }), null);
});
