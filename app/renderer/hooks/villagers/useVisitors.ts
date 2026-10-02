import { useQueries } from "@tanstack/react-query";
import {
  type DeviceRosterEntry,
  useDeviceRoster,
} from "@/components/shared/DeviceTabs";
import { queryKeysFor } from "@/lib/queryKeys";
import { type DeviceTally, mergeTallies } from "@/lib/villagers/visitors";

// Where a device's visitors stand on the page: added in, still being
// read, unreadable (a peer on a build from before the tally), or out
// of reach until it is back.
export interface VisitorSource {
  device: DeviceRosterEntry;
  state: "counted" | "loading" | "failed" | "offline";
}

// Who has visited, on every device on the account that can answer
// (cli/visitors.go, one tally per device), added up into one guest
// book. A device out of reach is left out until it is back, and named
// in `sources` so the page can say so. A villager moving in reads its
// device's tally again (lib/villagers/moves.ts), and a visit to the
// section or a return to the window reads them all.
export function useVisitors() {
  const roster = useDeviceRoster();
  const reachable = roster.flatMap((device) =>
    device.api !== undefined &&
    (device.isThisDevice || device.status?.reachable === true)
      ? [{ device, api: device.api }]
      : [],
  );
  const queries = useQueries({
    queries: reachable.map(({ device, api }) => ({
      queryKey: queryKeysFor(device.deviceId).villagerVisits(),
      queryFn: () => api.villagers.visits(),
      retry: false,
      meta: { silentError: true },
    })),
  });
  const tallies: DeviceTally[] = [];
  const sources: VisitorSource[] = roster.map((device) => {
    const query =
      queries[reachable.findIndex((entry) => entry.device === device)];
    if (query === undefined) return { device, state: "offline" };
    if (query.data !== undefined) {
      tallies.push({
        deviceId: device.deviceId,
        label: device.label,
        tally: query.data,
      });
      return { device, state: "counted" };
    }
    return { device, state: query.isError ? "failed" : "loading" };
  });
  const failed = queries.filter((query) => query.isError);
  return {
    merged: mergeTallies(tallies),
    sources,
    // Why there is nothing to show, when no device could be read.
    failure:
      tallies.length === 0 && failed.length > 0
        ? {
            message: failed[0]?.error?.message ?? "Couldn't read the visitors.",
            retry: () => {
              for (const query of failed) void query.refetch();
            },
          }
        : null,
    // Nothing to show until this device (or, on a client without one,
    // any device) has answered.
    loading:
      tallies.length === 0 &&
      sources.some((source) => source.state === "loading"),
  };
}
