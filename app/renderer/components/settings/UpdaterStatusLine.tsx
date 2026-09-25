import { InlineError } from "@/components/ui/inline-error";
import type { UpdaterState } from "@shared/schemas";

// The muted line for every state but error, null where the button says
// it all. A Record, so a new state kind has to be given a line here.
const STATUS_TEXT: Record<
  Exclude<UpdaterState["kind"], "error">,
  string | null
> = {
  unsupported:
    "Updates aren't automatic in this build; download new releases from GitHub.",
  idle: "You're up to date.",
  downloading: "Downloading update…",
  checking: null,
  ready: null,
};

// The button already speaks for itself when an update is ready, so we
// only surface a status line for the states where the button alone is
// ambiguous: idle ("you already checked, nothing to do"), downloading
// ("we're working on it"), and error.
export function UpdaterStatusLine({ state }: { state: UpdaterState | null }) {
  if (!state) return null;
  if (state.kind === "error") {
    return (
      <span className="flex min-w-0 gap-1 text-xs text-destructive">
        <span className="shrink-0">Update check failed:</span>
        <InlineError message={state.message} title="Update check failed" />
      </span>
    );
  }
  const text = STATUS_TEXT[state.kind];
  if (text === null) return null;
  return <span className="text-xs text-muted-foreground">{text}</span>;
}
