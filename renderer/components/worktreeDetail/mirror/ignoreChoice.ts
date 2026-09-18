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
  bringIgnores,
  broughtPaths,
  describeIgnores,
  ignoreCount,
  MIRROR_IGNORES_LIMIT,
  type MirrorIgnoreMode,
} from "@shared/ipc/modules/mirror";
import type { SyncIgnoredPathsResult } from "@shared/ipc/modules/sync";
import type { MirrorIgnoreChoice, PullChoice } from "@/hooks/remote/useMirrors";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";

// What stays behind before the exceptions: nothing, or what git
// ignores.
export type IgnoreBase = "everything" | "gitignored";
export const IGNORE_BASES: readonly IgnoreBase[] = ["everything", "gitignored"];

export type IgnoreSelection = {
  base: IgnoreBase;
  // The exceptions, each base's own so a switch of base and back loses
  // nothing: the ignored paths left out though nothing else is, and
  // the ignored paths brought though the rest stay.
  leftOut: ReadonlySet<string>;
  brought: ReadonlySet<string>;
};

export const DEFAULT_IGNORE_SELECTION: IgnoreSelection = {
  base: "everything",
  leftOut: new Set(),
  brought: new Set(),
};

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

// Whether the copy runs the setup script by default, by the rule: off
// when every file crosses (what setup would build, node_modules and
// the like, comes over with the rest), on when gitignored paths (or
// the user's pick of them) stay behind and the copy has to build its
// own. The dialog's switch overrides it.
export function setupDefaultFor(selection: IgnoreSelection): boolean {
  return modeOf(selection) !== "everything";
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
      ignoreMode === "custom"
        ? ignores.map((pattern) => pattern.replace(/^\//, ""))
        : [],
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

// The base as the segmented control names it. The heading beside the
// control says "Leave out", so the options answer that, and the list
// under it reads on from them: "nothing, except" and "gitignored,
// except".
export const IGNORE_BASE_LABEL: Record<IgnoreBase, string> = {
  everything: "Nothing",
  gitignored: "Gitignored",
};

export const IGNORE_BASE_TITLE: Record<IgnoreBase, string> = {
  everything: "Every file crosses, .git and your exceptions aside",
  gitignored: "What .gitignore matches stays put, your exceptions aside",
};

// An exception in each base's words: what adding one does, the picker
// row's button, and a picked row's note.
export const EXCEPTION_COPY: Record<
  IgnoreBase,
  { hint: string; action: string; done: string }
> = {
  everything: {
    hint: "Ignored files and folders to leave out anyway.",
    action: "Leave out",
    done: "Left out",
  },
  gitignored: {
    hint: "Ignored files and folders to bring anyway.",
    action: "Bring",
    done: "Brought",
  },
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

// The same chip for a rule still being picked, and for a live session.
export function selectionSummary(selection: IgnoreSelection): string | null {
  return ignoreSummary(modeOf(selection), exceptionsOf(selection).size);
}

export function sessionSummary(session: {
  ignoreMode: MirrorIgnoreMode;
  ignores: readonly string[];
}): string | null {
  return ignoreSummary(
    session.ignoreMode,
    ignoreCount(session.ignoreMode, session.ignores),
  );
}
