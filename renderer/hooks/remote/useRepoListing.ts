import { useQueries } from "@tanstack/react-query";
import type { Project } from "@shared/schemas";
import type { PickerEntry } from "@/components/shared/PickerRow";
import { isHolder, useDeviceTargets } from "@/components/shared/deviceTargets";
import { carryOverListingQueryOptions } from "@/hooks/projects/useCarryOverListing";

// Where one device holds an entry: in its main checkout, or only in
// the worktrees named.
export interface RepoEntryHolder {
  device: string;
  inPrimary: boolean;
  worktrees: string[];
}

// A folder entry of the repo as the devices holding it have it.
// `everywhere` when every one of them has it in its main checkout, so
// there is nothing to single out.
export type RepoListingEntry = PickerEntry & {
  holders: RepoEntryHolder[];
  everywhere: boolean;
};

// One folder of the repo, unioned across every device holding it: each
// device's own union of its checkouts (carryOverListingQueryOptions),
// merged by name. The leave-out preset holds on every device, so its
// picker has to offer a path that exists on a peer and not here. A
// device that is asleep contributes nothing, and neither does one
// without the folder (its listing throws), so only when no device can
// list it is this an error. A name is ignored only when every device
// holding it says so, the rule the per-device union already keeps: the
// preset must not leave out a path a checkout tracks. Devices are read
// in roster order, this one first, and a name any of them holds as a
// folder is one, so what a peer keeps under it can be reached.
//
// The listing is a plain read a peer serves without its command grant,
// the one its own Configure tab already shows here, so a read-only
// peer's files are offered too.
export function useRepoListing(project: Project, relative: string) {
  const holders = useDeviceTargets(project).filter(isHolder);
  const listings = useQueries({
    queries: holders.map((holder) => ({
      ...carryOverListingQueryOptions(
        holder.project.id,
        relative,
        { deviceId: holder.deviceId, api: holder.api },
        { ruleIgnored: true },
      ),
      // A device without the folder fails for good.
      retry: false,
      meta: { silentError: true },
    })),
  });
  const answered = listings.flatMap((listing, index) =>
    listing.data === undefined
      ? []
      : [{ device: holders[index].label, entries: listing.data }],
  );
  // The rows show once one device has answered and the rest fold in as
  // they land: a call to a peer has no timeout, so waiting on every
  // device would leave one stalled peer holding the whole picker.
  // isLoading, not isPending: an asleep device's disabled query stays
  // pending forever.
  const waiting =
    answered.length === 0 && listings.some((listing) => listing.isLoading);
  const failed = !waiting && answered.length === 0;
  return {
    data:
      waiting || failed ? undefined : unionListings(answered, holders.length),
    isPending: waiting,
    error: failed,
  };
}

function unionListings(
  answered: readonly {
    device: string;
    entries: readonly (PickerEntry & Omit<RepoEntryHolder, "device">)[];
  }[],
  // Every device holding the repo, answered or not: an entry is only
  // everywhere once each of them is known to have it.
  deviceCount: number,
): RepoListingEntry[] {
  const byName = new Map<string, RepoListingEntry>();
  for (const { device, entries } of answered) {
    for (const {
      name,
      isDirectory,
      ignored,
      inPrimary,
      worktrees,
    } of entries) {
      let held = byName.get(name);
      if (held === undefined) {
        held = { name, isDirectory, ignored, holders: [], everywhere: false };
        byName.set(name, held);
      }
      held.isDirectory ||= isDirectory;
      held.ignored &&= ignored;
      held.holders.push({ device, inPrimary, worktrees });
    }
  }
  for (const entry of byName.values()) {
    entry.everywhere =
      entry.holders.length === deviceCount &&
      entry.holders.every((holder) => holder.inPrimary);
  }
  // Folders first, then alphabetical, like each device's own listing.
  return [...byName.values()].toSorted(
    (a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) ||
      a.name.localeCompare(b.name),
  );
}
