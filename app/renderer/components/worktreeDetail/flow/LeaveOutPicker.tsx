// The leave-out section (LeaveOutPickerView.tsx) bound to a folder
// browser over the caller's files.
import { type ReactNode, useState } from "react";
import {
  PathPickerModal,
  type PathPickerModalProps,
} from "@/components/shared/PathPickerModal";
import type { PickerEntry } from "@shigomori/ui/views/shared/PickerRowView.tsx";
import { useWorktreeFolder } from "@/hooks/remote/useWorktreeFolder";
import type { IgnoreSelection } from "./ignoreChoice";
import {
  type IgnoredPaths,
  leaveOutEdit,
  LeaveOutPickerView,
  LeaveOutTrailingView,
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
      useWorktreeFolder(worktree.projectId, worktree.id, relative, true),
    emptyRootLabel: "The worktree is empty.",
  };
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
  ignored: IgnoredPaths;
  // What the custom picker browses.
  browse: LeaveOutBrowse<E>;
  disabled?: boolean;
  note?: ReactNode;
  children?: ReactNode;
}) {
  // The browser is a modal over the caller's own. It owns Escape while
  // it is up (PathPickerModal's capture listener), so the dialog under
  // it needs no say.
  const [picking, setPicking] = useState(false);
  const { bringing, excepted, copy, full, toggle } = leaveOutEdit(
    value,
    onChange,
  );
  return (
    <LeaveOutPickerView
      value={value}
      onChange={onChange}
      ignored={ignored}
      disabled={disabled}
      note={note}
      onBrowse={() => setPicking(true)}
      browser={
        picking && (
          <PathPickerModal
            {...browse}
            renderTrailing={(entry, path, insideIgnored) => (
              <LeaveOutTrailingView
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
        )
      }
    >
      {children}
    </LeaveOutPickerView>
  );
}
