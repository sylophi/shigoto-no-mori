// @vitest-environment happy-dom
// Proof that a default arriving in a focused field doesn't join what the
// person is typing (the walks after #1014: New worktree's branch name came
// out "sylviawalk-branch"). The picked animal name lands after the page
// opens with the field focused; a typing gesture that began on the empty
// field (its selection taken, its text not yet in) must replace the
// default, not append to it. Input's selectOutsideChanges selects a value
// set from outside under focus, so the text goes in over it.
//
// Run: pnpm test seeded-field.
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, it } from "vitest";
import { Input } from "@shigomori/ui/primitives/input.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement | undefined;
afterEach(() => host?.remove());

// The field as New worktree holds it: what the person typed, else the
// seed once it has arrived.
function mountSeeded() {
  host = document.body.appendChild(document.createElement("div"));
  let seed: ((value: string) => void) | undefined;
  function Field() {
    const [typed, setTyped] = useState<string | null>(null);
    const [seeded, setSeeded] = useState<string | null>(null);
    seed = setSeeded;
    return createElement(Input, {
      "aria-label": "Branch name",
      value: typed ?? seeded ?? "",
      onChange: (event) => setTyped(event.target.value),
      selectOutsideChanges: true,
    });
  }
  const root = createRoot(host);
  act(() => root.render(createElement(Field)));
  const field = host.querySelector("input");
  assert.ok(field);
  return { field, seed: (value: string) => act(() => seed?.(value)) };
}

// The browser's insert of typed text over the selection, and its input
// event. The prototype's setter, as the browser's own edit does, so
// React's value tracking hears it as a change.
const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)?.set;
function insertText(field: HTMLInputElement, text: string) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  act(() => {
    setValue?.call(
      field,
      field.value.slice(0, start) + text + field.value.slice(end),
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("a default landing mid-gesture is replaced by the text typed", () => {
  const { field, seed } = mountSeeded();
  field.focus();
  field.select();
  seed("sylvia");
  assert.equal(field.value, "sylvia");
  insertText(field, "walk-branch");
  assert.equal(field.value, "walk-branch");
});

it("text typed before the default arrives keeps the field", () => {
  const { field, seed } = mountSeeded();
  field.focus();
  insertText(field, "walk");
  seed("sylvia");
  assert.equal(field.value, "walk");
});
