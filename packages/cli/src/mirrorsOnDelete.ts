// The app runs this device's mirrors, so a delete from the terminal asks
// it to stop a worktree's mirror before the cleanup, and tells it after
// how the delete ended (the engine's MirrorsOnDelete). With no app
// running, nothing mirrors.
import { controlContract } from "@shigomori/contracts/modules/control";
import {
  type DeleteEnd,
  MirrorsOnDelete,
} from "@shigomori/engine/MirrorsOnDelete";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Control from "./Control.ts";

export const mirrorsOnDelete = Layer.effect(
  MirrorsOnDelete,
  Effect.map(Control.Control, (control) => {
    const app = control.client(controlContract);
    return MirrorsOnDelete.of({
      stop: (worktree) =>
        app.stopMirrorForDelete(worktree).pipe(
          Effect.as((end: DeleteEnd) =>
            (end === "short"
              ? app.mirrorDeleteStoppedShort(worktree)
              : app.mirrorDeleteDone({ ...worktree, gone: end === "gone" })
            ).pipe(Effect.ignore),
          ),
          Effect.catchTag("AppNotRunning", () =>
            Effect.succeed(() => Effect.void),
          ),
        ),
    });
  }),
);
