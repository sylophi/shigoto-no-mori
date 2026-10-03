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
// DeviceHostsView draws the strip.
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { DeviceHostsView } from "./DeviceHostsView";
import type { HostChip } from "./deviceHostChips";

export function DeviceHosts({
  deviceId,
  chips,
  loading,
  cached,
}: {
  // The machine these projects live on, for their icons.
  deviceId: string;
  chips: readonly HostChip[];
  // A first listing still in flight (DeviceHostsView).
  loading: boolean;
  // The device is not reachable right now, so the chips are its last
  // known forest (DeviceHostsView).
  cached: boolean;
}) {
  return (
    <DeviceHostsView
      chips={chips}
      loading={loading}
      cached={cached}
      renderIcon={(chip) => (
        <ProjectIcon
          projectId={chip.projectId}
          name={chip.name}
          deviceId={deviceId}
          className="size-3"
        />
      )}
    />
  );
}
