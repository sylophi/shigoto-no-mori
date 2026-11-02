// Whoever runs this device's mirrors (the app). A worktree's mirror
// stops before its delete's cleanup and any of its files go, so the
// other device never syncs what a cleanup script writes or a
// half-deleted worktree, and is told after how the delete ended: a
// delete takes the other side too, a worktree git's step kept ends its
// mirror, and one that stopped short of it (a cleanup that failed, a
// refusal, an interrupt) has its mirror go on. A process without it (no
// app running) has no mirror to stop.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type DeleteEnd = "gone" | "kept" | "short";

export type Stopped = (end: DeleteEnd) => Effect.Effect<void>;

export class MirrorsOnDelete extends Context.Service<
  MirrorsOnDelete,
  {
    readonly stop: (worktree: {
      readonly projectId: string;
      readonly worktreeId: string;
    }) => Effect.Effect<Stopped, unknown>;
  }
>()("sm/engine/MirrorsOnDelete") {}
