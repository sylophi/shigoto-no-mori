// Every script start and end, whoever ran it (a PTY run here, a script
// an engine run started), for the root to tell every window and peer
// (scripts:changed). Announced from the runs' own callbacks, so the
// announcement is synchronous; one change waiting is all a burst needs.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export class ScriptChanges extends Context.Service<
  ScriptChanges,
  {
    readonly announce: () => void;
    readonly changes: Stream.Stream<void>;
  }
>()("sm/host/ScriptChanges") {}

export const layer = Layer.effect(
  ScriptChanges,
  Effect.map(Queue.sliding<void>(1), (queue) =>
    ScriptChanges.of({
      announce: () => void Queue.offerUnsafe(queue, undefined),
      changes: Stream.fromQueue(queue),
    }),
  ),
);
