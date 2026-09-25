import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { LauncherCommand } from "@shared/schemas";
import { IconButton } from "@/components/ui/icon-button";

interface CustomLauncherInputProps {
  launcher: LauncherCommand;
  onChange: (patch: Partial<LauncherCommand>) => void;
  onRemove: () => void;
}

export function CustomLauncherInput({
  launcher,
  onChange,
  onRemove,
}: CustomLauncherInputProps) {
  return (
    <div className="grid grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)_auto] items-center gap-2">
      <Input
        type="text"
        value={launcher.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Label"
        aria-label="Launcher label"
        className="min-w-0 px-2.5 py-1.5 text-sm"
      />
      <Input
        type="text"
        value={launcher.command}
        onChange={(e) => onChange({ command: e.target.value })}
        placeholder="Command"
        aria-label="Launcher command"
        className="min-w-0 px-2.5 py-1.5 font-mono text-xs"
      />
      <IconButton
        onClick={onRemove}
        aria-label="Remove launcher"
        tone="destructive"
        className="p-1.5"
      >
        <X className="size-4" />
      </IconButton>
    </div>
  );
}
