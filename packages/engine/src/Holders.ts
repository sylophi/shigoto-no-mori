// Whoever runs processes in a worktree that its delete or move doesn't
// stop (the app's terminals), told to let them go right before the files
// go or move: Windows deletes or moves no folder a process works in. It
// comes after the delete's checks and its cleanup, so a delete they
// refuse keeps them, though one git's own last check refuses has let
// them go. The app provides it, and the CLI asks the running app.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// A worktree, or without `worktreeId` every one of the project.
type Owner = { readonly projectId: string; readonly worktreeId?: string };

export class Holders extends Context.Service<
  Holders,
  { readonly release: (owner: Owner) => Effect.Effect<void> }
>()("sm/engine/Holders") {}

export const releaseHolders = (owner: Owner) =>
  Effect.flatMap(Effect.serviceOption(Holders), (holders) =>
    Option.isNone(holders) ? Effect.void : holders.value.release(owner),
  );
