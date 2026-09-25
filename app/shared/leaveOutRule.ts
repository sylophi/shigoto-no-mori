// The leave-out rule of a mirror or transplant, from the selection (a
// base and its exceptions) to the engine's ignore list the host takes.
// Shared so the two surfaces that start one, the review dialog
// (renderer/components/worktreeDetail/flow/ignoreChoice.ts) and the
// CLI's control ops (host/ipc/modules/control.ts), come to the same
// rule and the same setup default from the same project preset.
import {
  anchorIgnoredPath,
  bringIgnores,
  MIRROR_IGNORES_LIMIT,
  type MirrorIgnoreMode,
} from "@shared/ipc/modules/mirror";
import type { SyncIgnoredPathsResult } from "@shared/ipc/modules/sync";
import type {
  LeaveOutPreset,
  LeaveOutPresetBase,
} from "@shared/sharedSettings";

export type IgnoreBase = LeaveOutPresetBase;

export type IgnoreSelection = {
  base: IgnoreBase;
  // The exceptions, each base's own so a switch of base and back loses
  // nothing: the ignored paths left out though nothing else is, and
  // the ignored paths brought though the rest stay.
  leftOut: ReadonlySet<string>;
  brought: ReadonlySet<string>;
};

// The rule and the engine patterns it resolves to, as the pull, send
// and mirror payloads take them.
export type MirrorIgnoreChoice = {
  ignoreMode: MirrorIgnoreMode;
  ignores: string[];
};

// The project's preset as a selection, and back.
export function selectionOfPreset(preset: LeaveOutPreset): IgnoreSelection {
  return {
    base: preset.base,
    leftOut: new Set(preset.leftOut),
    brought: new Set(preset.brought),
  };
}

export function presetOfSelection(selection: IgnoreSelection): LeaveOutPreset {
  return {
    base: selection.base,
    leftOut: [...selection.leftOut],
    brought: [...selection.brought],
  };
}

// The exceptions to the base in force.
export function exceptionsOf(selection: IgnoreSelection): ReadonlySet<string> {
  return selection.base === "everything"
    ? selection.leftOut
    : selection.brought;
}

// The rule the selection comes to. A base with no exceptions is the
// plain rule.
export function modeOf(selection: IgnoreSelection): MirrorIgnoreMode {
  const excepted = exceptionsOf(selection).size > 0;
  if (selection.base === "everything") {
    return excepted ? "custom" : "everything";
  }
  return excepted ? "bring" : "gitignored";
}

// Whether the rule resolves over the source worktree's gitignore rules
// (sync:ignoredPaths), so a caller reads that list only when it must.
export function needsIgnoredList(selection: IgnoreSelection): boolean {
  return selection.base === "gitignored";
}

// Whether the copy runs the setup script by default, by the rule: off
// when every file crosses (what setup would build, node_modules and
// the like, comes over with the rest), on when gitignored paths (or
// the user's pick of them) stay behind and the copy has to build its
// own. The dialog's switch overrides it.
export function setupDefaultFor(selection: IgnoreSelection): boolean {
  return modeOf(selection) !== "everything";
}

export function resolveIgnores(
  selection: IgnoreSelection,
  ignored: SyncIgnoredPathsResult | undefined,
): MirrorIgnoreChoice {
  const ignoreMode = modeOf(selection);
  switch (ignoreMode) {
    case "everything":
      return { ignoreMode, ignores: [] };
    case "gitignored":
      return {
        ignoreMode,
        ignores: (ignored?.patterns ?? []).slice(0, MIRROR_IGNORES_LIMIT),
      };
    case "custom":
      return {
        ignoreMode,
        ignores: [...selection.leftOut]
          .map(anchorIgnoredPath)
          .slice(0, MIRROR_IGNORES_LIMIT),
      };
    case "bring":
      return {
        ignoreMode,
        ignores: bringIgnores(
          ignored?.patterns ?? [],
          [...selection.brought].toSorted(),
        ),
      };
  }
}
