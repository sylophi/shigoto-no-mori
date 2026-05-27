import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EditorFooterProps {
  isDirty: boolean;
  isPending: boolean;
  isSuccess: boolean;
  onDiscard: () => void;
  onSave: () => void;
  canSave?: boolean;
}

export function EditorFooter({
  isDirty,
  isPending,
  isSuccess,
  onDiscard,
  onSave,
  canSave,
}: EditorFooterProps) {
  const saveEnabled = canSave ?? isDirty;
  return (
    <footer className="flex h-[38px] items-center gap-3 border-t border-border bg-card px-6">
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          isDirty ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {isDirty ? "Unsaved changes" : isSuccess ? "Saved." : ""}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={onDiscard}
        disabled={!isDirty || isPending}
      >
        Discard
      </Button>
      <Button size="xs" onClick={onSave} disabled={!saveEnabled || isPending}>
        <Save />
        {isPending ? "Saving…" : "Save"}
      </Button>
    </footer>
  );
}
