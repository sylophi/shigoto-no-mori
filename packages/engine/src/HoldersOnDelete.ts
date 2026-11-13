// Whoever runs processes in a worktree that its delete doesn't stop (the
// app's terminals), told to let them go right before the files go:
// Windows deletes no folder a process works in. It comes after the
// delete's checks and its cleanup, so a delete refused keeps them. A
// process without it (no app running) has none to let go.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class HoldersOnDelete extends Context.Service<
  HoldersOnDelete,
  {
    readonly release: (worktree: {
      readonly projectId: string;
      readonly worktreeId: string;
    }) => Effect.Effect<void>;
  }
>()("sm/engine/HoldersOnDelete") {}
