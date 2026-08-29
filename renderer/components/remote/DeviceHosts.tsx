// "Hosts": what a device actually has on it, as a chip per project with
// its worktree count. Chips, not copies -- each one is a project
// registered on THAT machine, which is the whole reason a second device
// is worth having on the account.
//
// A disconnected peer keeps whatever its last session cached (that is
// react-query's ordinary staleness contract, not a snapshot this file
// takes), so the strip stays populated while the machine is asleep and
// says "cached" rather than pretending the numbers are live.
import type { HostChip } from "./deviceHostChips";

export function DeviceHosts({
  chips,
  loading,
  cached,
}: {
  chips: readonly HostChip[];
  // A first listing still in flight. Rendered as nothing rather than a
  // skeleton: the row is already legible, and a strip that flickers in
  // is noisier than one that simply arrives.
  loading: boolean;
  // The chips are a disconnected device's last known forest.
  cached: boolean;
}) {
  if (chips.length === 0) {
    if (loading) return null;
    return (
      <p className="text-xs text-muted-foreground/70">no projects registered</p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground/70">Hosts</span>
      {chips.map((chip) => (
        <span
          key={chip.projectId}
          // The same data-slot the action chips carry, so the doubutsu
          // overlay fills it like every other chip on the page. Not a
          // button: a host chip names a fact, it does not do anything.
          data-slot="chip"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground/90 ring-1 ring-border ring-inset"
        >
          {chip.name}
          <span className="tabular text-muted-foreground/60">
            {chip.worktrees}
          </span>
        </span>
      ))}
      {cached && (
        <span className="text-[10px] text-muted-foreground/60">cached</span>
      )}
    </div>
  );
}
