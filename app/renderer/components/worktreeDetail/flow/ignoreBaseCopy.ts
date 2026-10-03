import type { IgnoreBase } from "@shared/leaveOutRule";

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
