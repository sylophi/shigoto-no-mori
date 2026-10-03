// A device's project strip as its registry row draws it (DeviceHosts
// looks up the icons): a chip per project with its icon and worktree
// count, led by a folder glyph, folding past a handful behind a count,
// and marked "last known" while the machine is away.
import { useState, type ReactNode } from "react";
import { FolderGit2 } from "lucide-react";
import { Chip, ChipButton } from "@/components/ui/chip-button";
import type { HostChip } from "./deviceHostChips";

// Enough to name a machine's forest at a glance. Past this the strip
// folds behind a count. A power user's main box can register dozens of
// repos, and a row three chips deep buries the switch under it.
const MAX_VISIBLE = 8;

export function DeviceHostsView<Item extends HostChip>({
  chips,
  loading,
  cached,
  renderIcon,
}: {
  chips: readonly Item[];
  // A first listing still in flight. Rendered as nothing rather than a
  // skeleton: the row is already legible, and a strip that flickers in
  // is noisier than one that simply arrives.
  loading: boolean;
  // The device is not reachable right now, so the chips are its last
  // known forest -- and an empty strip means nothing is KNOWN, not that
  // the machine has no projects.
  cached: boolean;
  // A chip's project icon, at the chip's size (ProjectIconView).
  renderIcon: (chip: Item) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (chips.length === 0 && loading) return null;
  const visible = expanded ? chips : chips.slice(0, MAX_VISIBLE);
  const hidden = chips.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <FolderGit2
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/50"
      />
      <span className="sr-only">Projects</span>
      {chips.length === 0 ? (
        <span className="text-xs text-muted-foreground/70">
          {cached ? "No projects known yet" : "No projects yet"}
        </span>
      ) : (
        visible.map((chip) => (
          <Chip key={chip.projectId} className="text-muted-foreground/90">
            {renderIcon(chip)}
            {chip.name}
            <span className="tabular text-muted-foreground/60">
              {chip.worktrees}
            </span>
          </Chip>
        ))
      )}
      {chips.length > MAX_VISIBLE && (
        <ChipButton onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? "Show fewer" : `+${hidden} more`}
        </ChipButton>
      )}
      {cached && chips.length > 0 && (
        <span className="text-3xs text-muted-foreground/60">last known</span>
      )}
    </div>
  );
}
