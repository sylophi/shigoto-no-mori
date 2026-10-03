// What a mirror leaves out, as one section: the heading and the base
// rule on one line, and under it the exceptions to that base. Nothing
// takes the ignored paths to leave out anyway, and gitignored (which
// lists what git ignores there today) takes the ignored paths to bring
// anyway, so one list serves as a leave-out list or a bring list by
// the base it hangs off. The list is the carry-over flow: the chosen
// paths as rows, and a button opening the same folder browser over the
// caller's files, where an ignored entry can be picked. What is browsed
// is the caller's: one worktree under the surrounding scope for a pull
// (the source's copy in the dialog, the local copy on the mirror's own
// page), since only what the source holds can cross, and the repo as
// every device holds it for the project's preset. The section's look
// is LeaveOutPickerView.tsx.
import { useState } from "react";
import { BRING_PATHS_LIMIT } from "@shared/ipc/modules/mirror";
import {
  PathPickerModal,
  type PathPickerModalProps,
} from "@/components/shared/PathPickerModal";
import type { PickerEntry } from "@/components/shared/PickerRow";
import { Button } from "@/components/ui/button";
import { MaterialIcon } from "@/components/ui/material-icon";
import { useWorktreeFolder } from "@/hooks/remote/useWorktreeFolder";
import { IGNORE_BASE_COPY } from "./ignoreBaseCopy";
import { exceptionsOf, type IgnoreSelection } from "./ignoreChoice";
import {
  type IgnoredPathsState,
  LeaveOutPickerView,
  withExceptionToggled,
} from "./LeaveOutPickerView";

// What the picker browses: the folder browser's own props, less the
// row control and the close, which are the picker's.
export type LeaveOutBrowse<E extends PickerEntry = PickerEntry> = Omit<
  PathPickerModalProps<E>,
  "renderTrailing" | "onClose"
>;

// One worktree, read under the surrounding scope.
export function browseWorktree(worktree: {
  projectId: string;
  id: string;
  path: string;
}): LeaveOutBrowse {
  return {
    rootPath: worktree.path,
    useListing: (relative) =>
      useWorktreeFolder(worktree.projectId, worktree.id, relative),
    emptyRootLabel: "The worktree is empty.",
  };
}

// A chosen path's icon, the file browser's own.
function fileIcon(name: string) {
  return <MaterialIcon kind="file" name={name} className="size-4" />;
}

export function LeaveOutPicker<E extends PickerEntry>({
  value,
  onChange,
  ignored,
  browse,
  disabled = false,
  note,
  children,
}: {
  value: IgnoreSelection;
  onChange: (next: IgnoreSelection) => void;
  ignored: IgnoredPathsState;
  // What the custom picker browses.
  browse: LeaveOutBrowse<E>;
  // Read-only: the rule shows, nothing changes it.
  disabled?: boolean;
  // What the rule is for, under the heading, where the surrounding
  // page does not already say (the Configure page's preset).
  note?: React.ReactNode;
  // Trailing content under the rule (the manage dialog's apply row).
  children?: React.ReactNode;
}) {
  // The browser is a modal over the caller's own. It owns Escape while
  // it is up (PathPickerModal's capture listener), so the dialog under
  // it needs no say.
  const [picking, setPicking] = useState(false);
  const bringing = value.base === "gitignored";
  const excepted = exceptionsOf(value);
  const toggle = (path: string) => onChange(withExceptionToggled(value, path));
  const copy = IGNORE_BASE_COPY[value.base];
  // Each brought path costs the gitignore rules two patterns of room.
  const full = bringing && excepted.size >= BRING_PATHS_LIMIT;
  return (
    <LeaveOutPickerView
      value={value}
      onChange={onChange}
      ignored={ignored}
      disabled={disabled}
      note={note}
      fileIcon={fileIcon}
      onAdd={() => setPicking(true)}
    >
      {children}
      {picking && (
        <PathPickerModal
          {...browse}
          renderTrailing={(entry, path, insideIgnored) => (
            <Trailing
              picked={excepted.has(path)}
              ignored={entry.ignored}
              // The engine never walks into a folder it leaves out, so a
              // path under one cannot be brought on its own.
              unreachable={bringing && insideIgnored}
              full={full}
              copy={copy}
              onPick={() => toggle(path)}
            />
          )}
          onClose={() => setPicking(false)}
        />
      )}
    </LeaveOutPickerView>
  );
}

// A picker row's control: the note on a picked path, the button on an
// ignored one that can take an exception, and why not otherwise.
function Trailing({
  picked,
  ignored,
  unreachable,
  full,
  copy,
  onPick,
}: {
  picked: boolean;
  ignored: boolean;
  unreachable: boolean;
  full: boolean;
  copy: { action: string; done: string };
  onPick: () => void;
}) {
  if (picked) {
    return (
      <span className="px-2 text-2xs text-muted-foreground">{copy.done}</span>
    );
  }
  // Why the row cannot be picked, as its tag and the tag's tooltip.
  const why: [string, string] | null = unreachable
    ? [
        "in ignored folder",
        "This is inside an ignored folder. Bring the whole folder instead.",
      ]
    : !ignored
      ? [
          "tracked",
          "Git tracks this, so it is always copied. Only ignored files and folders can be picked.",
        ]
      : full
        ? [
            "limit reached",
            `You can bring up to ${BRING_PATHS_LIMIT} paths. Bring a parent folder instead, or remove one.`,
          ]
        : null;
  if (why !== null) {
    return (
      <span className="px-2 text-2xs text-muted-foreground/70" title={why[1]}>
        {why[0]}
      </span>
    );
  }
  return (
    <div
      className="inline-flex items-center"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <Button type="button" variant="outline" size="xs" onClick={onPick}>
        {copy.action}
      </Button>
    </div>
  );
}
