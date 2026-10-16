// The band over the page while this machine's host is away (the shell
// starting it again), and for a moment after, saying why the shell did.
import { LoaderCircle, RotateCcw } from "lucide-react";
import type { HostRestartReasonSchema } from "@shigomori/contracts/modules/window";
import { TONE_FILL, TONE_MARK } from "../../primitives/status-dot.tsx";
import { cn, dragRegion } from "../../lib/utils.ts";

export type HostRestartReason = typeof HostRestartReasonSchema.Type;

export type HostBandState =
  | { readonly kind: "away" }
  | { readonly kind: "restarted"; readonly reason: HostRestartReason };

function restartWords(reason: HostRestartReason): string {
  if (reason.kind === "silent") {
    return `The app's background process stopped responding for ${reason.seconds} seconds and was restarted.`;
  }
  return reason.code === null
    ? "The app's background process quit unexpectedly and was restarted."
    : `The app's background process quit unexpectedly (code ${reason.code}) and was restarted.`;
}

export function HostBandView({ state }: { state: HostBandState }) {
  const away = state.kind === "away";
  const Mark = away ? LoaderCircle : RotateCcw;
  return (
    // At the top of the window, so the title bar drags by it.
    <div className="shrink-0 bg-background" style={dragRegion("drag")}>
      <div
        role="status"
        className={cn(
          "flex h-9 items-center gap-2 px-4 text-xs text-muted-foreground",
          TONE_FILL.amber,
        )}
      >
        <Mark
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            TONE_MARK.amber,
            away && "animate-spin",
          )}
        />
        <p className="min-w-0 flex-1 truncate">
          {away
            ? "Reconnecting to the app's background process…"
            : restartWords(state.reason)}
        </p>
      </div>
    </div>
  );
}
