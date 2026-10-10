// What a device actually has on it, as a chip per project with its
// icon and worktree count. Chips, not copies -- each one is a project
// registered on THAT machine, which is the whole reason a second device
// is worth having on the account. A folder glyph leads the strip in
// place of a word, the same way the port-forward strip below it leads
// with a cable, so the two sub-strips of a row line up.
//
// Icons are the repo's own (or the tile drawn from its name when it
// has none), read through the same ProjectIcon the sidebar draws,
// named by device so the fetch rides that machine's api and an
// offline peer keeps whatever icon its last session cached.
//
// A disconnected peer keeps whatever its last session cached (that is
// react-query's ordinary staleness contract, not a snapshot this file
// takes), so the strip stays populated while the machine is asleep and
// says "last known" rather than pretending the numbers are live.
import { type ReactNode, useState } from "react";
import { FolderGit2 } from "lucide-react";
import { Chip, ChipButton } from "@shigomori/ui/primitives/chip-button.tsx";
import type { HostChip } from "./deviceHostChips";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

// Enough to name a machine's forest at a glance. Past this the strip
// folds behind a count. A power user's main box can register dozens of
// repos, and a row three chips deep buries the switch under it.
const MAX_VISIBLE = 8;

export function DeviceHostsView({
  chips,
  loading,
  cached,
}: {
  // Each with its icon (ProjectIcon, named by device).
  chips: readonly (HostChip & { icon: ReactNode })[];
  // A first listing still in flight. Rendered as nothing rather than a
  // skeleton: the row is already legible, and a strip that flickers in
  // is noisier than one that simply arrives.
  loading: boolean;
  // The device is not reachable right now, so the chips are its last
  // known forest -- and an empty strip means nothing is KNOWN, not that
  // the machine has no projects.
  cached: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (chips.length === 0 && loading) return null;
  const visible = expanded ? chips : chips.slice(0, MAX_VISIBLE);
  const hidden = chips.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SimpleTooltip tip="Projects">
        <FolderGit2
          aria-label="Projects"
          className="size-3.5 shrink-0 text-muted-foreground/50"
        />
      </SimpleTooltip>
      {chips.length === 0 ? (
        <span className="text-xs text-muted-foreground/70">
          {cached ? "No projects known yet" : "No projects yet"}
        </span>
      ) : (
        visible.map((chip) => (
          <Chip key={chip.projectId} className="text-muted-foreground/90">
            {chip.icon}
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
