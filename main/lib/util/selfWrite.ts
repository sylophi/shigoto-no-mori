// Tracks when the app itself last wrote inside the shigomori root, so
// the state watcher can tell its own filesystem echo apart from a
// genuinely external change (a CLI run in a terminal). Every app-side
// writer that touches the root funnels through the chokepoints that
// call noteSelfWrite (store.ts, jsonFile.ts, the CLI runner); the
// watcher skips events landing within the echo window.
let lastSelfWrite = 0;

export function noteSelfWrite(): void {
  lastSelfWrite = Date.now();
}

export function selfWroteWithin(ms: number): boolean {
  return Date.now() - lastSelfWrite < ms;
}
