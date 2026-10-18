// The leave-out section (LeaveOutPickerView.tsx) bound to a folder
// browser over the caller's files.
import { type ReactNode, useState } from "react";
import {
  PathPickerModal,
  usePathSteps,
} from "@/components/shared/PathPickerModal";
import type { PathPickerProps } from "@shigomori/ui/views/shared/PathPickerView.tsx";
import type { PickerEntry } from "@shigomori/ui/views/shared/PickerRowView.tsx";
import type { SyncWorktreeFolderEntry } from "@shigomori/contracts/modules/sync";
import { useWorktreeFolder } from "@/hooks/remote/useWorktreeFolder";
import type { IgnoreSelection } from "./ignoreChoice";
import {
  type IgnoredPaths,
  leaveOutEdit,
  LeaveOutPickerView,
  LeaveOutTrailingView,
} from "@shigomori/ui/views/worktreeDetail/flow/LeaveOutPickerView.tsx";

// The row control and the close the picker hands the folder browser.
export type LeaveOutBrowsing = Pick<
  PathPickerProps<PickerEntry>,
  "renderTrailing" | "onClose"
>;

// What the picker browses: a folder browser over the caller's files.
export type LeaveOutBrowse = (browsing: LeaveOutBrowsing) => ReactNode;

type BrowsedWorktree = { projectId: string; id: string; path: string };

// One worktree, read under the surrounding scope.
export function browseWorktree(worktree: BrowsedWorktree): LeaveOutBrowse {
  return (browsing) => (
    <WorktreeFolderPicker worktree={worktree} {...browsing} />
  );
}

function WorktreeFolderPicker({
  worktree,
  ...browsing
}: LeaveOutBrowsing & { worktree: BrowsedWorktree }) {
  const steps = usePathSteps<SyncWorktreeFolderEntry>();
  const listing = useWorktreeFolder(
    worktree.projectId,
    worktree.id,
    steps.relative,
    true,
  );
  return (
    <PathPickerModal
      rootPath={worktree.path}
      emptyRootLabel="The worktree is empty."
      steps={steps}
      listing={listing}
      {...browsing}
    />
  );
}

// Each row's pick, by the rule being edited.
function trailingOf({
  bringing,
  excepted,
  copy,
  full,
  toggle,
}: ReturnType<typeof leaveOutEdit>): LeaveOutBrowsing["renderTrailing"] {
  return (entry, path, insideIgnored) => (
    <LeaveOutTrailingView
      picked={excepted.has(path)}
      ignored={entry.ignored}
      // The engine never walks into a folder it leaves out, so a path
      // under one cannot be brought on its own.
      unreachable={bringing && insideIgnored}
      full={full}
      copy={copy}
      onPick={() => toggle(path)}
    />
  );
}

export function LeaveOutPicker({
  value,
  onChange,
  ignored,
  renderBrowser,
  disabled = false,
  note,
  children,
}: {
  value: IgnoreSelection;
  onChange: (next: IgnoreSelection) => void;
  ignored: IgnoredPaths;
  // What the custom picker browses.
  renderBrowser: LeaveOutBrowse;
  disabled?: boolean;
  note?: ReactNode;
  children?: ReactNode;
}) {
  // The browser is a modal over the caller's own. It owns Escape while
  // it is up (PathPickerModal's capture listener), so the dialog under
  // it needs no say.
  const [picking, setPicking] = useState(false);
  return (
    <LeaveOutPickerView
      value={value}
      onChange={onChange}
      ignored={ignored}
      disabled={disabled}
      note={note}
      onBrowse={() => setPicking(true)}
      browser={
        picking &&
        renderBrowser({
          renderTrailing: trailingOf(leaveOutEdit(value, onChange)),
          onClose: () => setPicking(false),
        })
      }
    >
      {children}
    </LeaveOutPickerView>
  );
}
