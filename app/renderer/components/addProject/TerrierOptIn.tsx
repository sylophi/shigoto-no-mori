import { Checkbox } from "@/components/ui/checkbox";

export function TerrierOptIn({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="-mx-1 flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-muted-foreground select-none hover:bg-muted dark:hover:bg-muted/50">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} />
      Add to terrier
    </label>
  );
}
