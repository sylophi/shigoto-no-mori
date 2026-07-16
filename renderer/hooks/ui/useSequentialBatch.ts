import { useState, type Dispatch, type SetStateAction } from "react";
import { type RowStatus } from "@/components/ui/row-status";

// Drives the "run a mutation over a set of worktrees one at a time"
// flows (convert-external, relocate). Both seed a per-row running status,
// process each item sequentially, and record done/error per row.
//
// runBatch owns `batchRunning` (raised before `prepare`, cleared in a
// finally) so no caller can leave the flow's inputs permanently disabled
// by missing a reset on one exit path. `prepare` covers work that must
// run under the flag before the loop -- the relocate flow's config write
// -- and returning false aborts without touching the row statuses.
//
// The loop lives at module scope (not inside the hook) because React
// Compiler skips any component/hook containing a `finally` clause.
async function runBatchImpl<T>(
  setStatus: Dispatch<SetStateAction<Map<string, RowStatus>>>,
  setBatchRunning: Dispatch<SetStateAction<boolean>>,
  items: T[],
  keyOf: (item: T) => string,
  process: (item: T) => Promise<void>,
  opts?: { prepare?: () => Promise<boolean> },
): Promise<void> {
  setBatchRunning(true);
  try {
    if (opts?.prepare && !(await opts.prepare())) return;
    setStatus(
      new Map(items.map((item) => [keyOf(item), { kind: "running" as const }])),
    );
    for (const item of items) {
      const key = keyOf(item);
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential by design
        await process(item); // oxlint-disable-line no-await-in-loop -- sequential by design
        setStatus((prev) => {
          const next = new Map(prev);
          next.set(key, { kind: "done" });
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus((prev) => {
          const next = new Map(prev);
          next.set(key, { kind: "error", message });
          return next;
        });
      }
    }
  } finally {
    setBatchRunning(false);
  }
}

export function useSequentialBatch() {
  const [status, setStatus] = useState<Map<string, RowStatus>>(new Map());
  const [batchRunning, setBatchRunning] = useState(false);

  function runBatch<T>(
    items: T[],
    keyOf: (item: T) => string,
    process: (item: T) => Promise<void>,
    opts?: { prepare?: () => Promise<boolean> },
  ): Promise<void> {
    return runBatchImpl(
      setStatus,
      setBatchRunning,
      items,
      keyOf,
      process,
      opts,
    );
  }

  return { status, batchRunning, runBatch };
}
