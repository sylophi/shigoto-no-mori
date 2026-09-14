// The mirror's "leave out" choice, from the three-way rule the user
// picks to the engine's ignore list the host takes. Nothing resolves
// to no patterns (the engine still holds .git back). Gitignored
// resolves to the worktree's gitignore rules (host/lib/git/
// ignoreRules.ts: every .gitignore, anchored, plus info/exclude), so
// a file ignored later stays out too. Custom resolves to the paths the
// user picked, anchored to the root.
import {
  describeIgnores,
  MIRROR_IGNORES_LIMIT,
  type MirrorIgnoreMode,
} from "@shared/ipc/modules/mirror";
import type { SyncIgnoredPathsResult } from "@shared/ipc/modules/sync";
import type { MirrorIgnoreChoice } from "@/hooks/remote/useMirrors";

export type IgnoreSelection = {
  mode: MirrorIgnoreMode;
  // The ignored paths left out under the custom rule.
  selected: ReadonlySet<string>;
};

export const DEFAULT_IGNORE_SELECTION: IgnoreSelection = {
  mode: "everything",
  selected: new Set(),
};

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
