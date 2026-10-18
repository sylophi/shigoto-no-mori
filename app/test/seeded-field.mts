// @vitest-environment happy-dom
// Proof that a value arriving in a field the person is in doesn't merge
// with what they type (the walks after #1014: New worktree's branch name
// came out "sylviawalk-branch"). The picked animal name lands after the
// page opens with the field focused, so a typing gesture that began on
// the empty field (its selection taken, its text not yet in) must replace
// it. And a rename being typed keeps what is typed when the stored name
// changes underneath it. The real views, mounted in a DOM.
//
// Run: pnpm test seeded-field.
import assert from "node:assert/strict";
import { act, createElement, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, it } from "vitest";
import { Input } from "@shigomori/ui/primitives/input.tsx";
import { NEW_WORKTREE_FORM } from "@shigomori/ui/scenes/newCheckouts.tsx";
import { NewWorktreeFormView } from "@shigomori/ui/views/newWorktree/NewWorktreeView.tsx";
import { InlineNameEditorView } from "@shigomori/ui/views/shared/InlineNameEditorView.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function mount(element: React.ReactElement): HTMLElement {
  host = document.body.appendChild(document.createElement("div"));
  const mounted = createRoot(host);
  root = mounted;
  act(() => mounted.render(element));
  return host;
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

const fieldIn = (scope: HTMLElement, label: string) => {
  const field = scope.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"], input#${label}`,
  );
  assert.ok(field, `no ${label} field`);
  return field;
};

// New worktree's form as its container holds the branch name: what the
// person typed, else the picked name once it has arrived.
function mountNewWorktree() {
  let seed: ((name: string) => void) | undefined;
  function Form() {
    const [typed, setTyped] = useState<string | null>(null);
    const [picked, setPicked] = useState<string | null>(null);
    seed = setPicked;
    return createElement(NewWorktreeFormView, {
      ...NEW_WORKTREE_FORM,
      mode: "branch-from",
      sourcePicker: null,
      prSource: null,
      branchName: typed ?? picked ?? "",
      onBranchName: setTyped,
      useBranchAsFolder: true,
      prFolderFrom: "branch",
      folderName: "",
      folderSourceRaw: "",
      destPath: "",
      villager: null,
      canSubmit: false,
    });
  }
  const field = fieldIn(mount(createElement(Form)), "branch-name");
  return { field, seed: (name: string) => act(() => seed?.(name)) };
}

it("New worktree: a picked name landing mid-gesture is replaced by the text typed", () => {
  const { field, seed } = mountNewWorktree();
  assert.equal(field.ownerDocument.activeElement, field, "opens focused");
  field.select();
  seed("sylvia");
  assert.equal(field.value, "sylvia");
  insertText(field, "walk-branch");
  assert.equal(field.value, "walk-branch");
});

it("New worktree: text typed before the picked name arrives keeps the field", () => {
  const { field, seed } = mountNewWorktree();
  insertText(field, "walk");
  seed("sylvia");
  assert.equal(field.value, "walk");
});

it("a rename being typed keeps what is typed when the stored name changes", () => {
  let rename: ((name: string) => void) | undefined;
  function Editor() {
    const [name, setName] = useState("huck");
    rename = setName;
    return createElement(InlineNameEditorView, {
      name,
      label: "Worktree",
      pending: false,
      onSave: () => {},
      onCancel: () => {},
    });
  }
  const field = fieldIn(mount(createElement(Editor)), "Worktree name");
  act(() => rename?.("otter"));
  assert.equal(field.value, "otter", "an untouched draft follows the name");
  field.setSelectionRange(field.value.length, field.value.length);
  insertText(field, "-2");
  act(() => rename?.("badger"));
  assert.equal(field.value, "otter-2");
});

it("a caller's ref reaches the field", () => {
  const ref = createRef<HTMLInputElement>();
  mount(createElement(Input, { ref, "aria-label": "Port" }));
  assert.ok(ref.current instanceof HTMLInputElement);
});
