// Proof for a Configure draft over a project config that changed
// elsewhere while it was open (ui/lib/configureDraft.ts):
//   - a field the draft left alone takes the new value, so a Save
//     (a patch of what differs from the new config) sends only the
//     draft's own edit,
//   - its carry-over list keeps the draft's add, removal and mode
//     change and the entries added or removed elsewhere.
//
// Run: pnpm test configure-draft.
import assert from "node:assert/strict";
import { rebaseConfigureDraft } from "@shigomori/ui/lib/configureDraft.ts";
import type { ConfigureFormState } from "@shigomori/ui/views/configure/ConfigureFormView.tsx";
import { it } from "vitest";

const saved: ConfigureFormState = {
  defaultBranch: "main",
  setup: "",
  teardown: "",
  launchers: [],
  carryOver: [
    { path: ".env", mode: "copy" },
    { path: "data", mode: "symlink" },
    { path: "cache", mode: "copy" },
  ],
  useWorktreeInclude: true,
  showPrimaryInInbox: false,
};

it("keeps the draft's edits and takes every other field from the new config", () => {
  const form = { ...saved, setup: "pnpm install" };
  const next = { ...saved, teardown: "make clean" };
  const rebased = rebaseConfigureDraft(form, saved, next);
  assert.equal(rebased.setup, "pnpm install");
  assert.equal(rebased.teardown, "make clean");
  assert.deepEqual(rebased, { ...next, setup: "pnpm install" });
});

it("merges carry-over per path, the draft's changes over the new list", () => {
  const form: ConfigureFormState = {
    ...saved,
    carryOver: [
      { path: ".env", mode: "symlink" },
      { path: "cache", mode: "copy" },
      { path: "notes", mode: "copy" },
    ],
  };
  const next: ConfigureFormState = {
    ...saved,
    carryOver: [
      { path: ".env", mode: "copy" },
      { path: "data", mode: "symlink" },
      { path: "fixtures", mode: "copy" },
    ],
  };
  assert.deepEqual(rebaseConfigureDraft(form, saved, next).carryOver, [
    { path: ".env", mode: "symlink" },
    { path: "fixtures", mode: "copy" },
    { path: "notes", mode: "copy" },
  ]);
});
