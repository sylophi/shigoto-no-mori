// The one way a push, a session landing or an action asks the requests
// (React Query) to read again. A read already out is never cancelled:
// cancelling it makes its caller (throughCancel) ask again, so a burst
// of pushes would be a burst of reads, and a burst of device-list reads
// draws the hub's 429. The read out may predate what asked, so one more
// follows it as it settles, however many asked meanwhile: one read at a
// time per query.
import {
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
// next read instead. A read counts as landed by the cache's own success
// or error, since a cancelled read over data resolves with that data.
export function fetchAgain(
  queryClient: QueryClient,
  query: Query,
  onlyWhileRead: boolean,
): void {
  if (reading.has(query) || query.state.fetchStatus === "fetching") {
    owed.add(query);
    if (!onlyWhileRead) owedUnread.add(query);
    if (reading.has(query)) return;
  }
  reading.add(query);
  const cache = queryClient.getQueryCache();
  let landed = false;
  const unsubscribe = cache.subscribe((event) => {
    if (event.query !== query || event.type !== "updated") return;
    const { action } = event;
    if (
      (action.type === "success" && action.manual !== true) ||
      action.type === "error"
    ) {
      landed = true;
    }
  });
  void query
    .fetch(undefined, { cancelRefetch: false })
    .catch(() => undefined)
    .then(() => {
      unsubscribe();
      reading.delete(query);
      if (!owed.delete(query)) return;
      const unread = owedUnread.delete(query);
      // Removed meanwhile (the account left): nothing to read again.
      if (cache.get(query.queryHash) !== query) return;
      if (unread) return fetchAgain(queryClient, query, false);
      if (!landed || !query.isActive()) return query.invalidate();
      fetchAgain(queryClient, query, true);
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
    if (query.isActive()) fetchAgain(queryClient, query, true);
  }
}
