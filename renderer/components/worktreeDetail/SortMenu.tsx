import { SortMenu as SortMenuBase } from "@/components/ui/sort-menu";
import type { PackageScriptSortMode } from "@shared/schemas";

const SORT_OPTIONS: ReadonlyArray<{
  value: PackageScriptSortMode;
  label: string;
}> = [
  { value: "frequent", label: "Most used" },
  { value: "recent", label: "Most recently used" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "manifest", label: "package.json" },
];

export function SortMenu({
  value,
  onChange,
}: {
  value: PackageScriptSortMode;
  onChange: (mode: PackageScriptSortMode) => void;
}) {
  return (
    <SortMenuBase
      value={value}
      onChange={onChange}
      options={SORT_OPTIONS}
      ariaLabel="Sort scripts"
    />
  );
}
