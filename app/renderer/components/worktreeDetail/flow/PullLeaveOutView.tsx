// The pull dialogs' leave-out step as a plain view (PullLeaveOut.tsx
// gives it the folder browser): the rule, and under it the way to keep
// the rule as the project's preset while the two differ.
import { Bookmark } from "lucide-react";
import type { ReactNode } from "react";
import type { IgnoreSelection } from "@shared/leaveOutRule";
import { Button } from "@/components/ui/button";
import {
  type IgnoredPathsState,
  LeaveOutPickerView,
} from "./LeaveOutPickerView";

export function SaveAsPresetButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      title="Start from this rule whenever you mirror or transplant this project's worktrees, on any device. You can change it under Configure."
      onClick={onClick}
    >
      <Bookmark />
      Save as project default
    </Button>
  );
}

export function PullLeaveOutView({
  selection,
  onChange,
  ignored,
  presetDiffers,
  onSaveAsPreset,
  onAdd,
  fileIcon,
}: {
  selection: IgnoreSelection;
  onChange: (next: IgnoreSelection) => void;
  ignored: IgnoredPathsState;
  // The rule on screen is not the project's preset.
  presetDiffers: boolean;
  onSaveAsPreset: () => void;
  // Opens the browser the exceptions are picked in.
  onAdd: () => void;
  fileIcon?: (name: string) => ReactNode;
}) {
  return (
    <LeaveOutPickerView
      value={selection}
      onChange={onChange}
      ignored={ignored}
      fileIcon={fileIcon}
      onAdd={onAdd}
    >
      {presetDiffers && <SaveAsPresetButton onClick={onSaveAsPreset} />}
    </LeaveOutPickerView>
  );
}
