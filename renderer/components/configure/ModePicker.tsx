import { Copy as CopyIcon, Link as LinkIcon } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { CarryOverEntry } from "@shared/schemas";

interface ModePickerProps {
  mode: CarryOverEntry["mode"];
  onChange: (mode: CarryOverEntry["mode"]) => void;
}

const OPTIONS = [
  {
    value: "symlink",
    label: (
      <>
        <LinkIcon className="size-3" />
        Symlink
      </>
    ),
    title: "Edits stay in sync with the main checkout.",
  },
  {
    value: "copy",
    label: (
      <>
        <CopyIcon className="size-3" />
        Copy
      </>
    ),
    title: "Independent snapshot at worktree creation.",
  },
] as const;

export function ModePicker({ mode, onChange }: ModePickerProps) {
  return (
    <SegmentedControl
      aria-label="Carry-over mode"
      optionClassName="px-2 py-0.5 text-[11px]"
      value={mode}
      onChange={onChange}
      options={OPTIONS}
    />
  );
}
