import { Loader2 } from "lucide-react";

export function LifecycleBanner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-6 py-2 text-sm">
      <Loader2
        aria-hidden
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
