// Per-project action usage log: every successful action whose contract
// entry sets `tracksProjectUsage` counts as a use of its project. The
// app records the uses (they are the app's UI actions, not CLI verbs),
// and the project list reads them back as lastUsed and recentCount,
// which feed the sidebar's recency and frequency sorts.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ops from "../engineOps";
import { log } from "@shared/log";

const hasProjectId = Schema.is(
  Schema.Struct({ projectId: Schema.NonEmptyString }),
);

// This runs after roughly every action, so a failing store would log
// on every click. One line per app run is enough to point at the cause.
let usageFailureLogged = false;

// Called from the IPC registrar after an action whose contract entry sets
// `tracksProjectUsage` succeeds. Records a use of the project named by
// the payload and answers its id once recorded, so the caller can
// notify the renderer to refresh its usage-sorted list, or null if the
// payload had no project to attribute or the use wasn't recorded.
// Best-effort: never let a stats write break the handler.
export const recordProjectActionUsage = (input: unknown) => {
  if (!hasProjectId(input)) return Effect.succeed(null);
  return Ops.recordProjectUse(input.projectId).pipe(
    Effect.as(input.projectId),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        if (!usageFailureLogged) {
          usageFailureLogged = true;
          log.warn("[usage] project use log not recorded:", cause);
        }
        return null;
      }),
    ),
  );
};
