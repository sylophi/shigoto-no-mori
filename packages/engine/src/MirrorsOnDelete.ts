// Whoever runs this device's mirrors (the app). A worktree's mirror
// stops before any of its files go, so the other device never syncs a
// half-deleted worktree, and is told after whether they went: a delete
// takes the other side too, and a worktree kept ends its mirror. A
// process without it (no app running) has no mirror to stop.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type Stopped = (gone: boolean) => Effect.Effect<void>;

export class MirrorsOnDelete extends Context.Service<
  MirrorsOnDelete,
  {
    readonly stop: (worktree: {
      readonly projectId: string;
      readonly worktreeId: string;
    }) => Effect.Effect<Stopped, unknown>;
  }
>()("sm/engine/MirrorsOnDelete") {}
