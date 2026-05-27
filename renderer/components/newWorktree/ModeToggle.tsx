import { cn } from "@/lib/utils";

export type Mode = "branch-from" | "checkout";

export function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  disabled?: boolean;
}) {
  const options: { value: Mode; label: string }[] = [
    { value: "branch-from", label: "Branch from source" },
    { value: "checkout", label: "Check out source" },
  ];
  return (
    <div className="inline-flex rounded-md border border-input p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          disabled={disabled}
          className={cn(
            "rounded-[5px] px-3 py-1 text-xs transition-colors",
            mode === opt.value
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
