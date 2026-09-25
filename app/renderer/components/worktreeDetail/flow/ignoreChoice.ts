// The mirror's "leave out" choice, from the rule the user picks to
// the engine's ignore list the host takes. The user picks a base and
// names its exceptions, which covers a leave-out list and a bring list
// without asking which of the two they want: "nothing, except these"
// leaves the picked paths out, and "gitignored, except these" brings
// only the picked paths. Nothing resolves to no patterns (the engine
// still holds .git back). Gitignored resolves to the worktree's
// gitignore rules (host/lib/git/ignoreRules.ts: every .gitignore,
// anchored, plus info/exclude), so a file ignored later stays out too.
// An exception to nothing resolves to the paths the user picked,
// anchored to the root, and an exception to gitignored to the rules
// with the picked paths taken back out (bringIgnores).
import { useState } from "react";
import {
  broughtPaths,
  describeIgnores,
  type MirrorIgnoreMode,
  summarizeIgnores,
  unanchorIgnoredPath,
} from "@shared/ipc/modules/mirror";
import {
  exceptionsOf,
  type IgnoreBase,
  type IgnoreSelection,
  modeOf,
  presetOfSelection,
  resolveIgnores,
  selectionOfPreset,
  setupDefaultFor,
} from "@shared/leaveOutRule";
import {
  useLeaveOutPreset,
  useSaveLeaveOutPreset,
} from "@/hooks/sharedSettings/useLeaveOutPreset";
import { useSharedSettingsSettled } from "@/hooks/sharedSettings/useSharedSettings";
import type { PullChoice } from "@/hooks/remote/useMoveWorktree";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";

// The rule itself (the selection, its mode, the setup default and the
// patterns it resolves to) lives in shared/leaveOutRule.ts, which the
// CLI's control ops read too. Re-exported for the dialogs.
export {
  exceptionsOf,
  type IgnoreBase,
  type IgnoreSelection,
  modeOf,
  presetOfSelection,
  resolveIgnores,
  selectionOfPreset,
};

// What stays behind before the exceptions (nothing, or what git
// ignores), in the words each base goes by. The heading beside the
// segmented control says "Leave out", so `label` answers that, and the
// list under it reads on from the label: "nothing, except" and
// "gitignored, except". The rest is an exception in the base's words:
// the add button and its tooltip, the line over the picked rows, the
// picker row's button, and a picked row's note.
export const IGNORE_BASE_COPY = {
  everything: {
    label: "Nothing",
    title: "Copy every file, gitignored ones included",
    add: "Leave something out",
    hint: "Pick ignored files or folders to leave out.",
    lead: "Except these, which are left out:",
    action: "Leave out",
    done: "Left out",
  },
  gitignored: {
    label: "Gitignored",
    title: "Skip whatever .gitignore matches",
    add: "Bring something anyway",
    hint: "Pick ignored files or folders to bring anyway.",
    lead: "Except these, which are brought anyway:",
    action: "Bring",
    done: "Brought",
  },
} as const satisfies Record<IgnoreBase, unknown>;
// The review state a pull dialog (transplant or mirror) keeps: the
// leave-out rule, the ignored list the gitignored rule resolves over
// (read only once that rule is picked, since it walks the checkout
// over the device link), and the setup switch, which follows the rule
// until the user pins it. The rule opens on the project's preset (by
// the repo identity both ends share) until the user picks. `choice` is
// what the mutation takes, and `waiting` holds Start while the preset
// or the gitignored list is still on its way (or the copy would land
// with nothing left out).
export function usePullChoice(
  projectId: string,
  worktreeId: string,
  identity: string | null | undefined,
) {
  const preset = useLeaveOutPreset(identity);
  const presetRead = useSharedSettingsSettled();
  const savePreset = useSaveLeaveOutPreset(identity);
  // The preset as it stood when the dialog opened, taken once: a rule
  // under review must not move because another device saved a preset
  // meanwhile.
  const [opened, setOpened] = useState<IgnoreSelection | null>(null);
  if (opened === null && presetRead) setOpened(selectionOfPreset(preset));
  const [picked, setSelection] = useState<IgnoreSelection | null>(null);
  const selection = picked ?? opened ?? selectionOfPreset(preset);
  const [setupChoice, setSetupChoice] = useState<boolean | null>(null);
  const ignored = useWorktreeIgnoredPaths(projectId, worktreeId, {
    enabled: selection.base === "gitignored",
  });
  const runSetup = setupChoice ?? setupDefaultFor(selection);
  const choice: PullChoice = {
    ...resolveIgnores(selection, ignored.data),
    runSetup,
  };
  const needsList =
    selection.base === "gitignored" && ignored.data === undefined;
  return {
    selection,
    setSelection,
    ignored,
    // The rule on screen is not the project's preset, and can be made
    // it. Never for an identity-less project, which has none to keep.
    presetDiffers:
      identity != null &&
      picked !== null &&
      !sameSelection(picked, selectionOfPreset(preset)),
    saveAsPreset: () => savePreset(presetOfSelection(selection)),
    runSetup,
    setRunSetup: setSetupChoice,
    waiting: needsList || !presetRead,
    // Why Start is held, when the wait will not end on its own: the
    // list was refused or failed, so the rule has nothing to resolve
    // over and would leave nothing out.
    blocked:
      needsList && ignored.isError
        ? "The ignored files there could not be listed, so the gitignored rule cannot apply. Pick another rule."
        : null,
    choice,
  };
}
export type PullChoiceState = ReturnType<typeof usePullChoice>;

// The session's rule as a selection: custom patterns come back as the
// root-relative paths they were anchored from, and a bring rule's
// paths off the tail of its patterns.
export function selectionOf(session: {
  ignoreMode: MirrorIgnoreMode;
  ignores: readonly string[];
}): IgnoreSelection {
  const { ignoreMode, ignores } = session;
  return {
    base:
      ignoreMode === "everything" || ignoreMode === "custom"
        ? "everything"
        : "gitignored",
    leftOut: new Set(
      ignoreMode === "custom" ? ignores.map(unanchorIgnoredPath) : [],
    ),
    brought: new Set(ignoreMode === "bring" ? broughtPaths(ignores) : []),
  };
}

// Whether two selections come to the same rule: the other base's
// exceptions are not in force, so they do not count.
export function sameSelection(a: IgnoreSelection, b: IgnoreSelection) {
  if (a.base !== b.base) return false;
  const [ours, theirs] = [exceptionsOf(a), exceptionsOf(b)];
  if (ours.size !== theirs.size) return false;
  for (const path of ours) if (!theirs.has(path)) return false;
  return true;
}

// The rule as a chip on a live session, or nothing when it is the
// default: a mirror that leaves nothing out has nothing to declare.
// Lowercased beside the other chips ("clean tree", "no PR yet").
// Two ways in: a rule still being picked, and a live session.
function asChip(mode: MirrorIgnoreMode, phrase: string): string | null {
  return mode === "everything" ? null : phrase.toLowerCase();
}

export function selectionSummary(selection: IgnoreSelection): string | null {
  const mode = modeOf(selection);
  return asChip(mode, describeIgnores(mode, exceptionsOf(selection).size));
}

export function sessionSummary(session: {
  ignoreMode: MirrorIgnoreMode;
  ignores: readonly string[];
}): string | null {
  return asChip(
    session.ignoreMode,
    summarizeIgnores(session.ignoreMode, session.ignores),
  );
}
