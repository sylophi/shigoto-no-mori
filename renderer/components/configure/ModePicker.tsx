import { Copy as CopyIcon, Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CarryOverEntry } from "@shared/schemas";

interface ModePickerProps {
  mode: CarryOverEntry["mode"];
  onChange: (mode: CarryOverEntry["mode"]) => void;
}

export function ModePicker({ mode, onChange }: ModePickerProps) {
  const options: {
    value: CarryOverEntry["mode"];
    label: string;
    Icon: typeof LinkIcon;
    hint: string;
  }[] = [
    {
      value: "symlink",
      label: "Symlink",
      Icon: LinkIcon,
      hint: "Edits stay in sync with the main checkout.",
    },
    {
      value: "copy",
      label: "Copy",
      Icon: CopyIcon,
      hint: "Independent snapshot at worktree creation.",
    },
  ];
  return (
    <div
      data-slot="segmented-control"
      className="inline-flex shrink-0 rounded-md border border-input p-0.5"
    >
      {options.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.hint}
            className={cn(
              "inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[11px] transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <opt.Icon className="size-3" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
