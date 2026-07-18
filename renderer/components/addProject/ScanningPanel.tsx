import { ArrowLeft, FolderSearch, Loader2 } from "lucide-react";
import { PathSpan } from "@/components/ui/path-span";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

interface ScanningPanelProps {
  scanRoot: string;
  home: string | null;
  onCancel: () => void;
}

export function ScanningPanel({
  scanRoot,
  home,
  onCancel,
}: ScanningPanelProps) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
        <FolderSearch className="size-4 shrink-0 text-muted-foreground/80" />
        <PathSpan
          path={scanRoot}
          home={home}
          className="min-w-0 flex-1 truncate font-mono text-sm"
        />
      </div>
      <div className="flex flex-col items-center gap-3 px-4 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
        <span>Looking for git repos…</span>
      </div>
      <div className="flex items-center justify-end border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <KbdGroup>
          <Kbd>Esc</Kbd>
          <span className="text-muted-foreground/80">Cancel</span>
        </KbdGroup>
      </div>
    </div>
  );
}
