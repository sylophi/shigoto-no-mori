// The Configure page's "Leave out" preset: the rule every mirror and
// transplant of the repo opens on, which the dialog can still change
// for the one pull. A shared setting like "Create on", and for the same
// reason: a pull has a device at each end, so the preset has to hold on
// both. The picker is the dialogs' own, browsing every checkout on
// every device holding the repo at once (useRepoListing): a preset
// names paths for pulls from any of them, and an ignored file may sit
// on one machine alone. The list of what git ignores stays the scoped
// device's primary checkout, as a sample of what the rule covers.
import { useState } from "react";
import type { Project } from "@shared/schemas";
import {
  useLeaveOutPreset,
  useSaveLeaveOutPreset,
} from "@/hooks/sharedSettings/useLeaveOutPreset";
import {
  type RepoListingEntry,
  useRepoListing,
} from "@/hooks/remote/useRepoListing";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  type IgnoreSelection,
  presetOfSelection,
  sameSelection,
  selectionOfPreset,
} from "../worktreeDetail/flow/ignoreChoice";
import { LeaveOutPicker } from "../worktreeDetail/flow/LeaveOutPicker";
import { FoundOnDevices } from "./OnlyInWorktrees";

const NOTE =
  "The default when you mirror or transplant one of this project's worktrees.";

// Where a row was found, unless every device has it in its main
// checkout.
function foundOn(entry: RepoListingEntry) {
  return entry.everywhere ? null : (
    <FoundOnDevices holders={entry.holders} className="max-w-56" />
  );
}

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
      browse={{
        // The repo by name: a folder here may sit on a peer alone, under
        // no path this device has.
        rootPath: project.name,
        useListing: (relative) => useRepoListing(project, relative),
        renderProvenance: foundOn,
      }}
      note={NOTE}
    />
  );
}
