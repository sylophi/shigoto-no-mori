// The mark a peer's worktree wears while this machine forwards its
// ports (switched on from its port list): the Ports glyph in the
// live tone, the mappings in the tooltip. Worn in the tree's rows and
// the inbox's, beside the device and mirror marks.
import { Cable } from "lucide-react";
import type { Worktree } from "@shigomori/contracts/schemas";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useWorktreeForwardTip } from "@/hooks/remote/usePortForwards";
import { cn } from "@/lib/utils";

export function ForwardMark({
  deviceId,
  worktree,
}: {
  deviceId: string;
  worktree: Worktree;
}) {
  const tip = useWorktreeForwardTip(deviceId, worktree);
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
