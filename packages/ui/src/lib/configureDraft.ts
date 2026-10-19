import type { CarryOverEntry } from "@shigomori/contracts/schemas";
import { keepTouched } from "../hooks/useDirtyForm.ts";
import type { ConfigureFormState } from "../views/configure/ConfigureFormView.tsx";

const byPath = (entries: readonly CarryOverEntry[]) =>
  new Map(entries.map((entry) => [entry.path, entry]));

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// A Configure draft over a config that changed elsewhere (the terminal,
// a peer, a worktree create dropping what .worktreeinclude covers): the
// fields it left alone take the new config, and its carry-over list
// takes the draft's own adds, removals and mode changes per path over
// the new list, so neither side's entries are lost.
export function rebaseConfigureDraft(
  form: ConfigureFormState,
  saved: ConfigureFormState,
  next: ConfigureFormState,
): ConfigureFormState {
  return {
    ...keepTouched(form, saved, next),
    carryOver: rebaseCarryOver(form.carryOver, saved.carryOver, next.carryOver),
  };
}

function rebaseCarryOver(
  form: readonly CarryOverEntry[],
  saved: readonly CarryOverEntry[],
  next: readonly CarryOverEntry[],
): CarryOverEntry[] {
  const drafted = byPath(form);
  const before = byPath(saved);
  const rebased: CarryOverEntry[] = [];
  for (const entry of next) {
    const draft = drafted.get(entry.path);
    const was = before.get(entry.path);
    if (draft === undefined) {
      if (was === undefined) rebased.push(entry);
    } else {
      rebased.push(same(draft, was) ? entry : draft);
    }
  }
  const kept = new Set(next.map((entry) => entry.path));
  for (const entry of form) {
    if (!kept.has(entry.path) && !before.has(entry.path)) rebased.push(entry);
  }
  return rebased;
}
