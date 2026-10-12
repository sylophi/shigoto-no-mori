// Which device a request reads, and over which api, for the queries a
// scoped caller (a useHostScope consumer, the sidebar's remote fan-out)
// runs on any device. A peer's data caches under its own id, and an api
// of undefined means "this device has no connection": nothing is asked.
import { MAX_IN_FLIGHT_PER_PEER } from "@shared/remote/link";
import type { HostApi } from "@/hooks/remote/useHostScope";

export type HostForestScope = {
  readonly deviceId: string;
  readonly api: HostApi | undefined;
};

// How many of the per-project reads (a project's pull requests, its
// config, its icon, its GitHub description) go to one device at once.
// The sidebar and the projects page ask them of every project, four
// calls a project, and a first run that turns terrier on lists every
// repo the person has in one go. The link lets a share of the host's
// MAX_IN_FLIGHT_PER_PEER out at once and queues the rest in order
// (shared/remote/rpcTransport.ts, LINK_CALLS_IN_FLIGHT), so a burst of
// these alone would put the page's own calls behind hundreds of them:
// held to a quarter of the cap, they leave the link's other places to
// the page.
const FOREST_READS_PER_DEVICE = MAX_IN_FLIGHT_PER_PEER / 4;

const forestQueues = new Map<
  string,
  { active: number; waiting: (() => void)[] }
>();

// Runs a per-project read for `deviceId` once fewer than
// FOREST_READS_PER_DEVICE of them are out, first come first served.
export async function forestRead<A>(
  deviceId: string,
  read: () => Promise<A>,
): Promise<A> {
  let queue = forestQueues.get(deviceId);
  if (queue === undefined) {
    queue = { active: 0, waiting: [] };
    forestQueues.set(deviceId, queue);
  }
  if (queue.active >= FOREST_READS_PER_DEVICE) {
    await new Promise<void>((resolve) => queue.waiting.push(resolve));
  } else {
    queue.active += 1;
  }
  try {
    return await read();
  } finally {
    // The slot passes straight to the next read, or frees.
    const next = queue.waiting.shift();
    if (next === undefined) queue.active -= 1;
    else next();
  }
}

// A fan-out's results as the fields consumers read, through
// useQueries' combine. Without one, useQueries hands back a fresh
// array of fresh objects every render, so nothing downstream can stay
// memoized; projecting routes it through replaceEqualDeep, which keeps
// identity when nothing changed.
export function combineFanOut<T>(
  results: readonly {
    data: T | undefined;
    error: Error | null;
    isLoading: boolean;
    isPending: boolean;
  }[],
) {
  return results.map((result) => ({
    data: result.data,
    error: result.error,
    isLoading: result.isLoading,
    isPending: result.isPending,
  }));
}
