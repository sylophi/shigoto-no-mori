import { assertNever } from "@/lib/utils";
import type { UpdaterState } from "@shared/schemas";

// The button already speaks for itself when an update is ready, so we
// only surface a status line for the states where the button alone is
// ambiguous: idle ("you already checked, nothing to do"), downloading
// ("we're working on it"), and error.
export function UpdaterStatusLine({ state }: { state: UpdaterState | null }) {
  if (!state) return null;
  switch (state.kind) {
    case "idle":
      return (
        <span className="text-xs text-muted-foreground">
          You're up to date.
        </span>
      );
    case "downloading":
      return (
        <span className="text-xs text-muted-foreground">
          Downloading update…
        </span>
      );
    case "error":
      return (
        <span className="text-xs text-destructive" title={state.message}>
          Update check failed.
        </span>
      );
    case "checking":
    case "ready":
      return null;
    default:
      return assertNever(state);
  }
}
