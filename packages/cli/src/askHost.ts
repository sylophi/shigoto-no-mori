// One call to the running host, its answer as the contract types it:
// the loopback's client decoded it before Control handed it on.
import * as Control from "@shigomori/engine/Control";
import * as Effect from "effect/Effect";

export const askHost = <T>(channel: string, input?: unknown) =>
  Effect.flatMap(
    Control.Control,
    (control) =>
      control.call(channel, input) as Effect.Effect<T, Control.ControlError>,
  );
