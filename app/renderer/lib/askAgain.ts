// The one way a push, a session landing or an action asks the requests
// (React Query) to read again. A read already out is never cancelled:
// cancelling it sent the next, and its caller (throughCancel) asked
// again, so a burst of pushes was a burst of reads, which the hub
// answered with 429 for the device list (#947). The read out may
// predate what asked, so one more follows it as it settles, however
// many asked meanwhile: one read at a time per query.
import {
  isCancelledError,
  type Query,
  type QueryClient,
  type QueryFilters,
} from "@tanstack/react-query";

// Queries this module has a read out for, those owed one more, and
// those owed it even with no page reading them (the device list, which
// the sidebar's store follows).
const reading = new WeakSet<Query>();
const owed = new WeakSet<Query>();
const owedUnread = new WeakSet<Query>();

// Reads `query` again, joining a read already out and following it with
// one more. `onlyWhileRead`: the follow-up is skipped once no page reads
// the query, or once the read was cancelled under a page (it left, or an
// optimistic write cancelled it), and the query is left stale for the
// next read instead.
export function fetchAgain(query: Query, onlyWhileRead: boolean): void {
  if (reading.has(query) || query.state.fetchStatus === "fetching") {
    owed.add(query);
    if (!onlyWhileRead) owedUnread.add(query);
    if (reading.has(query)) return;
  }
  reading.add(query);
  void query
    .fetch(undefined, { cancelRefetch: false })
    .then(
      () => false,
      (error: unknown) => isCancelledError(error),
    )
    .then((cancelled) => {
      reading.delete(query);
      if (!owed.delete(query)) return;
      if (owedUnread.delete(query)) return fetchAgain(query, false);
      if (cancelled || !query.isActive()) return query.invalidate();
      fetchAgain(query, true);
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
