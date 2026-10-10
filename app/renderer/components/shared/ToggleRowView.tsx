import { Switch } from "@shigomori/ui/primitives/switch.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";

interface ToggleRowProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  switchClassName?: string;
}

export function ToggleRowView({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  switchClassName,
}: ToggleRowProps) {
  return (
    // The hover fill bleeds past the row on a negative margin, which
    // would beat the gap a space-y parent gives the row. A flow-root box
    // contains it, so the fill overhangs without moving the neighbors.
    <div className="flow-root">
      <label
        className={cn(
          "-m-1 flex items-start gap-3 rounded-md p-1",
          // The row has no fill of its own, so the hover fill ghost
          // buttons wear gives doubutsu's stripes something to sit on.
          disabled
            ? "cursor-not-allowed"
            : "cursor-pointer hover:bg-muted dark:hover:bg-muted/50",
        )}
      >
        <span className={cn("mt-0.5", disabled && "opacity-50")}>
          <Switch
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            className={switchClassName}
          />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className={cn("text-sm", disabled && "opacity-50")}>
            {label}
          </span>
          {description && (
            <span className="text-xs text-muted-foreground">{description}</span>
          )}
        </div>
      </label>
    </div>
  );
}
