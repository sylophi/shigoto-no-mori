import { assertNever } from "@/lib/utils";
import { InlineError } from "@/components/ui/inline-error";
import type { UpdaterState } from "@shared/schemas";

// The button already speaks for itself when an update is ready, so we
// only surface a status line for the states where the button alone is
// ambiguous: idle ("you already checked, nothing to do"), downloading
// ("we're working on it"), and error.
export function UpdaterStatusLine({ state }: { state: UpdaterState | null }) {
  if (!state) return null;
  switch (state.kind) {
    case "unsupported":
      return (
        <span className="text-xs text-muted-foreground">
          Updates aren't automatic in this build; download new releases from
          GitHub.
        </span>
      );
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
        <span className="flex min-w-0 gap-1 text-xs text-destructive">
          <span className="shrink-0">Update check failed:</span>
          <InlineError message={state.message} title="Update check failed" />
        </span>
      );
    case "checking":
    case "ready":
      return null;
    default:
      return assertNever(state);
  }
}
