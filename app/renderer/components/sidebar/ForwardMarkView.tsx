// The mark a peer's worktree wears while this machine forwards its
// ports (switched on from its Ports dialog): the Ports glyph in the
// live tone, the mappings in the tooltip. Worn in the tree's rows and
// the inbox's, beside the device and mirror marks. Nothing without a
// forward. ForwardMark looks the forward up.
import { Cable } from "lucide-react";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ForwardMarkView({ tip }: { tip: string | undefined }) {
  if (tip === undefined) return null;
  return (
    <SimpleTooltip tip={tip}>
      <Cable
        aria-label={tip}
        className={cn("size-3 shrink-0", TONE_TEXT.emerald)}
      />
    </SimpleTooltip>
  );
}
