// The app runs this device's mirrors, so a delete from the terminal asks
// it to stop a worktree's mirror before the files go, and tells it after
// whether they went (the engine's MirrorsOnDelete). With no app running,
// nothing mirrors.
import * as Control from "@shigomori/engine/Control";
import { MirrorsOnDelete } from "@shigomori/engine/MirrorsOnDelete";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const mirrorsOnDelete = Layer.effect(
  MirrorsOnDelete,
  Effect.map(Control.Control, (control) =>
    MirrorsOnDelete.of({
      stop: (worktree) =>
        control.call("control:stopMirrorForDelete", worktree).pipe(
          Effect.as((gone: boolean) =>
            control
              .call("control:mirrorDeleteDone", { ...worktree, gone })
              .pipe(Effect.ignore),
          ),
          Effect.catchTag("AppNotRunning", () =>
            Effect.succeed(() => Effect.void),
          ),
        ),
    }),
  ),
);
