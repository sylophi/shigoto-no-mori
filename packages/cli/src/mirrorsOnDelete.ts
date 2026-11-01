// The app runs this device's mirrors, so a delete from the terminal asks
// it to stop a worktree's mirror before the files go, and tells it after
// whether they went (the engine's MirrorsOnDelete). With no app running,
// nothing mirrors.
import { controlContract } from "@shigomori/contracts/modules/control";
import { MirrorsOnDelete } from "@shigomori/engine/MirrorsOnDelete";
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
          Effect.as((gone: boolean) =>
            app.mirrorDeleteDone({ ...worktree, gone }).pipe(Effect.ignore),
          ),
          Effect.catchTag("AppNotRunning", () =>
            Effect.succeed(() => Effect.void),
          ),
        ),
    });
  }),
);
