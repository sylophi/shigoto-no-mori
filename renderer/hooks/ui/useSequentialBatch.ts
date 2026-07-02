import { useState } from "react";
import { type RowStatus } from "@/components/ui/row-status";

// Drives the "run a mutation over a set of worktrees one at a time"
// flows (convert-external, relocate). Both seed a per-row running status,
// process each item sequentially, and record done/error per row.
//
// The caller owns `batchRunning` rather than runBatch toggling it, because
// each flow gates extra work on the flag around the loop itself: the
// relocate flow holds it true across a preceding config write, and both
// disable inputs while it's set.
export function useSequentialBatch() {
  const [status, setStatus] = useState<Map<string, RowStatus>>(new Map());
  const [batchRunning, setBatchRunning] = useState(false);

  async function runBatch<T>(
    items: T[],
    keyOf: (item: T) => string,
    process: (item: T) => Promise<void>,
  ): Promise<void> {
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
  }

  return { status, batchRunning, setBatchRunning, runBatch };
}
