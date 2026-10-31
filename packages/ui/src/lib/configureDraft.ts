import {
  type CarryOverEntry,
  PROJECT_CONFIG_DEFAULTS,
  type ProjectSettingsPatch,
  type ShigomoriConfig,
} from "@shigomori/contracts/schemas";
import { keepTouched } from "../hooks/useDirtyForm.ts";
import type { ConfigureFormState } from "../views/configure/ConfigureFormView.tsx";

// The Configure form's state for a project's settings, and back.
export function fromConfig(
  config: ShigomoriConfig | null,
  resolvedDefaultBranch: string,
): ConfigureFormState {
  return {
    defaultBranch: config?.defaultBranch ?? resolvedDefaultBranch,
    setup: config?.scripts?.setup ?? "",
    teardown: config?.scripts?.teardown ?? "",
    launchers: config?.launchers ?? PROJECT_CONFIG_DEFAULTS.launchers,
    carryOver: config?.carryOver ?? PROJECT_CONFIG_DEFAULTS.carryOver,
    useWorktreeInclude:
      config?.useWorktreeInclude ?? PROJECT_CONFIG_DEFAULTS.useWorktreeInclude,
    showPrimaryInInbox:
      config?.showPrimaryInInbox ?? PROJECT_CONFIG_DEFAULTS.showPrimaryInInbox,
  };
}

const unlessDefault = <T>(value: T, fallback: T): T | undefined =>
  value === fallback ? undefined : value;

export function toConfig(
  original: ShigomoriConfig | null,
  state: ConfigureFormState,
): ShigomoriConfig {
  const scripts: { setup?: string; teardown?: string } = {};
  if (state.setup.trim()) scripts.setup = state.setup;
  if (state.teardown.trim()) scripts.teardown = state.teardown;

  const validLaunchers = state.launchers.filter(
    (l) => l.label.trim().length > 0 && l.command.trim().length > 0,
  );

  return {
    ...original,
    defaultBranch: state.defaultBranch.trim(),
    scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
    launchers: validLaunchers.length > 0 ? validLaunchers : undefined,
    carryOver: state.carryOver.length > 0 ? state.carryOver : undefined,
    // Defaults are stored by omission.
    useWorktreeInclude: unlessDefault(
      state.useWorktreeInclude,
      PROJECT_CONFIG_DEFAULTS.useWorktreeInclude,
    ),
    showPrimaryInInbox: unlessDefault(
      state.showPrimaryInInbox,
      PROJECT_CONFIG_DEFAULTS.showPrimaryInInbox,
    ),
  };
}

// The settings this form edits that differ between two of its documents,
// each as `after` has it, or null for one it left out: what a save
// changes, and nothing it didn't touch.
export function patchOf(
  before: ShigomoriConfig,
  after: ShigomoriConfig,
): ProjectSettingsPatch {
  const fields = {
    defaultBranch: [before.defaultBranch, after.defaultBranch],
    "scripts.setup": [before.scripts?.setup, after.scripts?.setup],
    "scripts.teardown": [before.scripts?.teardown, after.scripts?.teardown],
    launchers: [before.launchers, after.launchers],
    carryOver: [before.carryOver, after.carryOver],
    useWorktreeInclude: [before.useWorktreeInclude, after.useWorktreeInclude],
    showPrimaryInInbox: [before.showPrimaryInInbox, after.showPrimaryInInbox],
  } as const;
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, [was, now]]) => !same(was, now))
      .map(([key, [, now]]) => [key, now ?? null]),
  ) as ProjectSettingsPatch;
}

// The form's snapshot once a Save of `form` over `saved` landed, `prev`
// being the snapshot by then: only the fields the Save carried advance,
// as persisted, not as the raw form had them. toConfig drops
// half-filled launcher rows and normalizes fields, and snapshotting the
// raw form would mark those leftovers clean, so the post-save refetch
// would reseed them away. Both sides are normalized, so a field stored
// in another shape than the form's (an empty list, a padded branch) is
// not taken for one the Save carried, and a change made elsewhere while
// the Save was out stays.
export function snapshotAfterSave(
  original: ShigomoriConfig | null,
  resolvedDefaultBranch: string,
  form: ConfigureFormState,
  saved: ConfigureFormState,
  prev: ConfigureFormState,
): ConfigureFormState {
  return rebaseConfigureDraft(
    fromConfig(toConfig(original, form), resolvedDefaultBranch),
    fromConfig(toConfig(original, saved), resolvedDefaultBranch),
    prev,
  );
}

const byPath = (entries: readonly CarryOverEntry[]) =>
  new Map(entries.map((entry) => [entry.path, entry]));

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// A Configure draft over a config that changed elsewhere (the terminal,
// a peer, a worktree create dropping what .worktreeinclude covers): the
// fields it left alone take the new config, and its carry-over list
// takes the draft's own adds, removals and mode changes per path over
// the new list. An entry removed elsewhere stays removed, a mode the
// draft gave it with it.
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
