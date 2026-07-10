import { SegmentedControl } from "@/components/ui/segmented-control";

export type Mode = "branch-from" | "checkout";

const OPTIONS = [
  { value: "branch-from", label: "Branch from source" },
  { value: "checkout", label: "Check out source" },
] as const;

export function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentedControl
      aria-label="Worktree source mode"
      value={mode}
      onChange={onChange}
      options={OPTIONS}
      disabled={disabled}
    />
  );
}
