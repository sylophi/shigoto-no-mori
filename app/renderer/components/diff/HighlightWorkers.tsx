import type { ReactNode } from "react";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
// oxlint-disable-next-line import/default -- vite's ?worker import is the worker's constructor
import HighlightWorker from "@pierre/diffs/worker/worker.js?worker";
import { CODE_THEME } from "@shigomori/ui/views/diff/codeTheme.ts";

// Highlighting for the diffs and the file viewer runs in workers: pierre
// draws a file's text at once and colors it when a worker answers, so a
// big file, or many in view, doesn't hold the window. The pool is the
// app's, mounted once, since pierre ends its workers with the last
// provider and a new pool colors nothing until its workers are up. The
// theme is the pool's, not each file's.
const HIGHLIGHT_POOL = {
  workerFactory: () => new HighlightWorker(),
  poolSize: 2,
};
const HIGHLIGHTER = { theme: CODE_THEME.theme };

export function HighlightWorkers({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider
      poolOptions={HIGHLIGHT_POOL}
      highlighterOptions={HIGHLIGHTER}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}
