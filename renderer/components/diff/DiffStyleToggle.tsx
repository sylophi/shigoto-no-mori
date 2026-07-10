import { SegmentedControl } from "@/components/ui/segmented-control";

export type DiffStyle = "unified" | "split";

const OPTIONS = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
] as const;

export function DiffStyleToggle({
  value,
  onChange,
}: {
  value: DiffStyle;
  onChange: (next: DiffStyle) => void;
}) {
  return (
    <SegmentedControl
      aria-label="Diff layout"
      className="self-center"
      optionClassName="px-2 py-1 text-xs"
      value={value}
      onChange={onChange}
      options={OPTIONS}
    />
  );
}
