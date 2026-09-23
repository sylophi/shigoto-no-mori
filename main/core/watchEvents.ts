// fs.watch as a Stream, for the git-directory watcher (gitWatcher.ts)
// and the data-dir watcher (electron/stateWatcher.ts): each changed
// path `accept` lets through, as it lands. The watch handle lives in
// the stream's scope: it opens when the stream starts and closes when
// the stream ends, however it ends. A watch that cannot open (a
// directory missing or vanished, a platform without recursive
// watches), or that errors later (the directory deleted or
// unmounted), ends the stream.
import { watch } from "node:fs";
import { Effect, Queue, Stream } from "effect";

export function watchEvents(
  dir: string,
  options: { recursive: boolean },
  accept: (file: string | null) => boolean,
): Stream.Stream<string | null> {
  return Stream.callback<string | null>((queue) =>
    Effect.acquireRelease(
      Effect.try(() => {
        const watcher = watch(
          dir,
          { recursive: options.recursive, persistent: false },
          (_eventType, file) => {
            if (accept(file)) Queue.offerUnsafe(queue, file);
          },
        );
        watcher.on("error", () => {
          Queue.endUnsafe(queue);
        });
        return watcher;
      }),
      (watcher) => Effect.sync(() => watcher.close()),
    ).pipe(Effect.catch(() => Queue.end(queue))),
  );
}
