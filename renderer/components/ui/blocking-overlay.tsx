import { Loader2 } from "lucide-react";

// Full-window veil for root-wide operations that must not be clicked
// through while they run (nuke, data-folder move): blocks interaction
// and shows a single progress line.
export function BlockingOverlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
