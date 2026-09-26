import { useState, type Dispatch, type SetStateAction } from "react";
import { type RowStatus } from "@/components/ui/row-status";
import { errorMessageOf } from "@shared/errors";
import { holdVillagerMoves } from "@/lib/villagers/moves";

// Drives the "run a mutation over a set of worktrees one at a time"
// flows (convert-external, relocate, Tidy). Both seed a per-row running status,
// process each item sequentially, and record done/error per row.
//
// runBatch owns `batchRunning` (raised before `prepare`, cleared in a
// finally) so no caller can leave the flow's inputs permanently disabled
// by missing a reset on one exit path. `prepare` covers work that must
// run under the flag before the loop (the relocate flow's config write),
// and returning false aborts without touching the row statuses.
//
// The loop lives at module scope (not inside the hook) because React
// Compiler skips any component/hook containing a `finally` clause.
type BatchArgs<T> = [
  items: T[],
  keyOf: (item: T) => string,
  process: (item: T) => Promise<void>,
  opts?: { prepare?: () => Promise<boolean> },
];

async function runBatchImpl<T>(
  setStatus: Dispatch<SetStateAction<Map<string, RowStatus>>>,
  setBatchRunning: Dispatch<SetStateAction<boolean>>,
  ...[items, keyOf, process, opts]: BatchArgs<T>
): Promise<void> {
  setBatchRunning(true);
  // Villagers the batch moves say so together once it is done
  // (lib/villagers/moves.ts), not one toast per step.
  const releaseMoves = holdVillagerMoves();
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
        setStatus((prev) => new Map(prev).set(key, { kind: "done" }));
      } catch (err) {
        const message = errorMessageOf(err);
        setStatus((prev) => new Map(prev).set(key, { kind: "error", message }));
      }
    }
  } finally {
    releaseMoves();
    setBatchRunning(false);
  }
}

export function useSequentialBatch() {
  const [status, setStatus] = useState<Map<string, RowStatus>>(new Map());
  const [batchRunning, setBatchRunning] = useState(false);

  function runBatch<T>(...args: BatchArgs<T>): Promise<void> {
    return runBatchImpl(setStatus, setBatchRunning, ...args);
  }

  return { status, batchRunning, runBatch };
}
