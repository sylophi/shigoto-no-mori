import { Copy as CopyIcon, Link as LinkIcon } from "lucide-react";
import type { CarryOverEntry } from "@shigomori/contracts/schemas";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

// A carry-over picker row's control: Symlink and Copy on an ignored
// path, and why not otherwise.
export function CarryOverTrailingView({
  added,
  covered,
  ignored,
  onPick,
}: {
  // Already in the list.
  added: boolean;
  // .worktreeinclude already copies it into every new worktree.
  covered: boolean;
  ignored: boolean;
  onPick: (mode: CarryOverEntry["mode"]) => void;
}) {
  return added ? (
    <span className="px-2 text-2xs text-muted-foreground">Added</span>
  ) : covered ? (
    <SimpleTooltip tip=".worktreeinclude already copies this path into every new worktree.">
      <span className="px-2 text-2xs text-amber-600 dark:text-amber-400">
        covered
      </span>
    </SimpleTooltip>
  ) : ignored ? (
    <div
      className="inline-flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => onPick("symlink")}
      >
        <LinkIcon />
        Symlink
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => onPick("copy")}
      >
        <CopyIcon />
        Copy
      </Button>
    </div>
  ) : (
    <SimpleTooltip tip="Tracked by git. Only ignored files and folders can be carried over.">
      <span className="px-2 text-2xs text-muted-foreground/70">tracked</span>
    </SimpleTooltip>
  );
}
