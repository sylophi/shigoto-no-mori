import type { ReactNode } from "react";
import { WorkerPoolContext } from "@pierre/diffs/react";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
// oxlint-disable-next-line import/default -- vite's ?worker import is the worker's constructor
import HighlightWorker from "@pierre/diffs/worker/worker.js?worker";
import { CODE_THEME } from "@shigomori/ui/views/diff/codeTheme.ts";

// Highlighting for the diff pages runs in workers: pierre draws a file's
// text at once and colors it when a worker answers, so a big file, or
// many in view, doesn't hold the window. The pool is made when a diff
// page first draws and kept from then on, where pierre's own provider
// ends it with the last page and a new pool colors nothing until its
// workers are up. The theme is the pool's, not each file's.
const pool = () =>
  getOrCreateWorkerPoolSingleton({
    poolOptions: {
      workerFactory: () => new HighlightWorker(),
      poolSize: 2,
    },
    highlighterOptions: { theme: CODE_THEME.theme },
  });

export function HighlightWorkers({ children }: { children: ReactNode }) {
  return <WorkerPoolContext value={pool()}>{children}</WorkerPoolContext>;
}
