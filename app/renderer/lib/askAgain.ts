// The one way a push, a session landing or an action asks the requests
// (React Query) to read again. A read already out is never cancelled:
// cancelling it sent the next, and its caller (throughCancel) asked
// again, so a burst of pushes was a burst of reads, which the hub
// answered with 429 for the device list (#947). The read out may
// predate what asked, so one more follows it as it settles, however
// many asked meanwhile: one read at a time per query.
import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";

// Queries this module has a read out for, and those owed one more.
const reading = new WeakSet<Query>();
const owed = new WeakSet<Query>();

// Reads `query` again, joining a read already out and following it with
// one more. `onlyWhileRead`: the follow-up is skipped once no page reads
// the query, which stays stale for the next page to read.
export function fetchAgain(query: Query, onlyWhileRead: boolean): void {
  if (reading.has(query)) {
    owed.add(query);
    return;
  }
  if (query.state.fetchStatus === "fetching") owed.add(query);
  reading.add(query);
  void query
    .fetch(undefined, { cancelRefetch: false })
    .catch(() => undefined)
    .finally(() => {
      reading.delete(query);
      if (!owed.delete(query)) return;
      if (onlyWhileRead && !query.isActive()) return;
      fetchAgain(query, onlyWhileRead);
    });
}

// invalidateQueries for a refresh: the matching queries go stale, and
// each one a page reads is read again as fetchAgain does.
export function refreshQueries(
  queryClient: QueryClient,
  filters: QueryFilters,
): void {
  void queryClient.invalidateQueries({ ...filters, refetchType: "none" });
  for (const query of queryClient.getQueryCache().findAll(filters)) {
    if (query.isActive()) fetchAgain(query, true);
  }
}
