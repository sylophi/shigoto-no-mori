import { PawPrint } from "lucide-react";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";

// Terrier's mark: the paw on a terrier-sourced project (Project.source),
// on its page's header and, with Mark terrier projects on, its title
// in the sidebar while it is the open project. One glyph and one tooltip for every place that says it.
export function TerrierPawView({ className }: { className?: string }) {
  return (
    <SimpleTooltip tip="Registered via terrier">
      <span className="inline-flex shrink-0">
        <PawPrint
          aria-label="Registered via terrier"
          className={cn("text-muted-foreground/70", className)}
        />
      </span>
    </SimpleTooltip>
  );
}
