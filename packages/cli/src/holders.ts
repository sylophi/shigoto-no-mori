// The app runs this device's terminals, so a delete or a move from the
// terminal asks it to let go of the worktree first (the engine's
// Holders), but for the app's terminal this process runs in, whose end
// would end this one. With no app running, nothing holds it, and an app
// that can't answer leaves the delete or the move as no app would: one
// that something still holds fails on that.
import {
  controlContract,
  TERMINAL_ID_ENV,
} from "@shigomori/contracts/modules/control";
import { Holders } from "@shigomori/engine/Holders";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Control from "./Control.ts";

export const holders = Layer.effect(
  Holders,
  Effect.map(Control.Control, (control) => {
    const app = control.client(controlContract);
    return Holders.of({
      release: (owner) =>
        app
          .releaseHolders({ ...owner, spare: process.env[TERMINAL_ID_ENV] })
          .pipe(Effect.ignore),
    });
  }),
);
