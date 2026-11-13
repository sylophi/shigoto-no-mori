// Whoever runs processes in a worktree that its delete doesn't stop (the
// app's terminals), told to let them go right before the files go:
// Windows deletes no folder a process works in. It comes after the
// delete's checks and its cleanup, so a delete refused keeps them. A
// process without it (no app running) has none to let go.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// A worktree, or without `worktreeId` every one of the project.
type Owner = { readonly projectId: string; readonly worktreeId?: string };

export class HoldersOnDelete extends Context.Service<
  HoldersOnDelete,
  { readonly release: (owner: Owner) => Effect.Effect<void> }
>()("sm/engine/HoldersOnDelete") {}

export const releaseHolders = (owner: Owner) =>
  Effect.flatMap(Effect.serviceOption(HoldersOnDelete), (holders) =>
    Option.isNone(holders) ? Effect.void : holders.value.release(owner),
  );
