// The mirror's "leave out" choice, from the three-way rule the user
// picks to the engine's ignore list the host takes. Nothing resolves
// to no patterns (the engine still holds .git back). Gitignored
// resolves to the worktree's gitignore rules (host/lib/git/
// ignoreRules.ts: every .gitignore, anchored, plus info/exclude), so
// a file ignored later stays out too. Custom resolves to the paths the
// user picked, anchored to the root.
import { useState } from "react";
import {
  describeIgnores,
  MIRROR_IGNORES_LIMIT,
  type MirrorIgnoreMode,
} from "@shared/ipc/modules/mirror";
import type { SyncIgnoredPathsResult } from "@shared/ipc/modules/sync";
import type { MirrorIgnoreChoice, PullChoice } from "@/hooks/remote/useMirrors";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";

export type IgnoreSelection = {
  mode: MirrorIgnoreMode;
  // The ignored paths left out under the custom rule.
  selected: ReadonlySet<string>;
};

export const DEFAULT_IGNORE_SELECTION: IgnoreSelection = {
  mode: "everything",
  selected: new Set(),
};

// Whether the copy runs the setup script by default, by the rule: off
// when every file crosses (what setup would build, node_modules and
// the like, comes over with the rest), on when gitignored paths (or
// the user's pick of them) stay behind and the copy has to build its
// own. A custom rule with nothing picked leaves nothing out, so it
// reads as off too. The dialog's switch overrides it.
export function setupDefaultFor(selection: IgnoreSelection): boolean {
  switch (selection.mode) {
    case "everything":
      return false;
    case "gitignored":
      return true;
    case "custom":
      return selection.selected.size > 0;
  }
}

// The review state a pull dialog (transplant or mirror) keeps: the
// leave-out rule, the ignored list the gitignored rule resolves over
// (read only once that rule is picked, since it walks the checkout
// over the device link), and the setup switch, which follows the rule
// until the user pins it. `choice` is what the mutation takes, and
// `waiting` holds Start while the gitignored list is still on its way
// (or the copy would land with nothing left out).
export function usePullChoice(projectId: string, worktreeId: string) {
  const [selection, setSelection] = useState<IgnoreSelection>(
    DEFAULT_IGNORE_SELECTION,
  );
  const [setupChoice, setSetupChoice] = useState<boolean | null>(null);
  const ignored = useWorktreeIgnoredPaths(projectId, worktreeId, {
    enabled: selection.mode === "gitignored",
  });
  const runSetup = setupChoice ?? setupDefaultFor(selection);
  const choice: PullChoice = {
    ...resolveIgnores(selection, ignored.data),
    runSetup,
  };
  const needsList =
    selection.mode === "gitignored" && ignored.data === undefined;
  return {
    selection,
    setSelection,
    ignored,
    runSetup,
    setupPinned: setupChoice !== null,
    setRunSetup: setSetupChoice,
    waiting: needsList,
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

// An ignored path as `git ls-files` lists it (a fully ignored folder
// ends in a slash) as a root-anchored engine pattern.
function anchorIgnoredPath(path: string): string {
  return `/${path.replace(/\/+$/, "")}`;
}

export function resolveIgnores(
  selection: IgnoreSelection,
  ignored: SyncIgnoredPathsResult | undefined,
): MirrorIgnoreChoice {
  switch (selection.mode) {
    case "everything":
      return { ignoreMode: "everything", ignores: [] };
    case "gitignored":
      return {
        ignoreMode: "gitignored",
        ignores: (ignored?.patterns ?? []).slice(0, MIRROR_IGNORES_LIMIT),
      };
    case "custom":
      return {
        ignoreMode: "custom",
        ignores: [...selection.selected]
          .map(anchorIgnoredPath)
          .slice(0, MIRROR_IGNORES_LIMIT),
      };
  }
}

// The session's rule as a selection: custom patterns come back as the
// root-relative paths they were anchored from.
export function selectionOf(session: {
  ignoreMode: MirrorIgnoreMode;
  ignores: readonly string[];
}): IgnoreSelection {
  return {
    mode: session.ignoreMode,
    selected: new Set(
      session.ignoreMode === "custom"
        ? session.ignores.map((pattern) => pattern.replace(/^\//, ""))
        : [],
    ),
  };
}

export function sameSelection(a: IgnoreSelection, b: IgnoreSelection) {
  if (a.mode !== b.mode) return false;
  if (a.mode !== "custom") return true;
  if (a.selected.size !== b.selected.size) return false;
  for (const path of a.selected) if (!b.selected.has(path)) return false;
  return true;
}

// The rule as the segmented control names it. The heading beside the
// control says "Leave out", so the options answer that.
export const IGNORE_MODE_LABEL: Record<MirrorIgnoreMode, string> = {
  everything: "Nothing",
  gitignored: "Gitignored",
  custom: "Custom",
};

export const IGNORE_MODE_TITLE: Record<MirrorIgnoreMode, string> = {
  everything: "Every file crosses, .git aside",
  gitignored: "What .gitignore matches stays put",
  custom: "Pick the ignored paths that stay put",
};

// The rule as a chip on a live session, or nothing when it is the
// default: a mirror that leaves nothing out has nothing to declare.
// Lowercased beside the other chips ("clean tree", "no PR yet").
export function ignoreSummary(
  mode: MirrorIgnoreMode,
  count: number,
): string | null {
  return mode === "everything"
    ? null
    : describeIgnores(mode, count).toLowerCase();
}
