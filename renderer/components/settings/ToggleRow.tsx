import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface ToggleRowProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
  description?: React.ReactNode;
  disabled?: boolean;
}

export function ToggleRow({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
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
