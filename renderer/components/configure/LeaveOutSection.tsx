// The Configure page's "Leave out" preset: the rule every mirror and
// transplant of the repo opens on, which the dialog can still change
// for the one pull. A shared setting like "Create on", and for the same
// reason: a pull has a device at each end, so the preset has to hold on
// both. The picker is the dialogs' own, browsing the primary checkout
// of the device the page is scoped to, since ignored paths are much
// the same in every checkout of a repo.
import { useState } from "react";
import type { Project } from "@shared/schemas";
import {
  useLeaveOutPreset,
  useSaveLeaveOutPreset,
} from "@/hooks/sharedSettings/useLeaveOutPreset";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  type IgnoreSelection,
  presetOfSelection,
  sameSelection,
  selectionOfPreset,
} from "../worktreeDetail/flow/ignoreChoice";
import { LeaveOutPicker } from "../worktreeDetail/flow/LeaveOutPicker";

const NOTE =
  "The default when you mirror or transplant one of this project's worktrees.";

export function LeaveOutSection({ project }: { project: Project }) {
  const worktrees = useWorktrees(project.id);
  const primary = worktrees.data?.find((worktree) => worktree.isPrimary);
  const stored = selectionOfPreset(useLeaveOutPreset(project.identity));
  const save = useSaveLeaveOutPreset(project.identity);
  // A pick shows at once and the stored rule catches up behind it, so
  // two picks in a row build on each other instead of on a rule the
  // first has not reached yet. Dropped once the stored rule agrees,
  // which lets a later pick made on another device show.
  const [draft, setDraft] = useState<IgnoreSelection | null>(null);
  if (draft !== null && sameSelection(draft, stored)) setDraft(null);
  const selection = draft ?? stored;
  const listing = useWorktreeIgnoredPaths(project.id, primary?.id ?? "", {
    enabled: primary !== undefined && selection.base === "gitignored",
  });
  // Only a repo two devices hold can be pulled, and only it has the
  // identity a preset is kept by.
  if (project.identity == null) return null;
  return (
    <LeaveOutPicker
      value={selection}
      onChange={(next) => {
        // A click on the base already in force is not a pick.
        if (sameSelection(next, selection)) return;
        if (save(presetOfSelection(next))) setDraft(next);
      }}
      // With no checkout to walk there is no list, and never will be.
      ignored={
        primary !== undefined
          ? listing
          : {
              data: undefined,
              isPending: worktrees.isPending,
              isError: !worktrees.isPending,
            }
      }
      worktree={
        primary && { projectId: project.id, id: primary.id, path: primary.path }
      }
      note={NOTE}
    >
      {primary === undefined && !worktrees.isPending && (
        <p className="text-xs text-muted-foreground">
          Couldn&apos;t read this project&apos;s checkout, so there are no files
          to pick from.
        </p>
      )}
    </LeaveOutPicker>
  );
}
