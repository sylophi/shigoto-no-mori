import { cn } from "@/lib/utils";

export type DiffStyle = "unified" | "split";

export function DiffStyleToggle({
  value,
  onChange,
}: {
  value: DiffStyle;
  onChange: (next: DiffStyle) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Diff layout"
      className="inline-flex shrink-0 self-center rounded-md border border-border bg-muted/30 p-0.5 text-xs"
    >
      <ToggleOption
        active={value === "unified"}
        onClick={() => onChange("unified")}
        label="Unified"
      />
      <ToggleOption
        active={value === "split"}
        onClick={() => onChange("split")}
        label="Split"
      />
    </div>
  );
}

function ToggleOption({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded px-2 py-1 transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
