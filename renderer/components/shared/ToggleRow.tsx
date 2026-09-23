import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface ToggleRowProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  switchClassName?: string;
}

export function ToggleRow({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  switchClassName,
}: ToggleRowProps) {
  return (
    <label
      className={cn(
        "flex items-start gap-3",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
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
        <span className={cn("text-sm", disabled && "opacity-50")}>{label}</span>
        {description && (
          <span className="text-xs text-muted-foreground">{description}</span>
        )}
      </div>
    </label>
  );
}
