// Per-project action usage log: every successful action whose contract
// entry sets `tracksProjectUsage` counts as a use of its project. The
// app records the uses (they are the app's UI actions, not CLI verbs),
// and the project list reads them back as lastUsed and recentCount,
// which feed the sidebar's recency and frequency sorts.
import * as Engine from "../engine";
import * as Ops from "../engineOps";
import { log } from "@shared/log";

function hasStringProjectId(input: unknown): input is { projectId: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { projectId?: unknown }).projectId === "string" &&
    (input as { projectId: string }).projectId.length > 0
  );
}

// This runs after roughly every action, so a failing store would log
// on every click. One line per app run is enough to point at the cause.
let usageFailureLogged = false;

// Called from the IPC registrar after an action whose contract entry sets
// `tracksProjectUsage` succeeds. Records a use of the project named by
// the payload and answers its id once recorded, so the caller can
// notify the renderer to refresh its usage-sorted list, or null if the
// payload had no project to attribute or the use wasn't recorded.
// Best-effort: never let a stats write break the handler.
export async function recordProjectActionUsage(
  input: unknown,
): Promise<string | null> {
  if (!hasStringProjectId(input)) return null;
  try {
    await Engine.run(Ops.recordProjectUse(input.projectId));
    return input.projectId;
  } catch (error) {
    if (!usageFailureLogged) {
      usageFailureLogged = true;
      log.warn("[usage] project use log not recorded:", error);
    }
    return null;
  }
}
