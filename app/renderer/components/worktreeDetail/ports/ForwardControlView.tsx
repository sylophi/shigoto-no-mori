// The forward band under a remote port's header: on the left the
// mapping as a form, `<device>:<remote port> -> localhost:<field>`. On
// the right the switch with its state spelled out, and Open once the
// forward is up. The switch does not wait for a server: a forward to a
// port with nothing listening stays on and reaches the server once one
// comes up, and the state word says it is waiting. The field is the
// local end. While the forward is off it shows the remembered
// preference (default: the same number as the remote port, the least
// surprising place for it to land). While it is on it shows where the
// listener actually bound, and committing a new number moves the
// listener there. Failures land under the band rather than in a toast,
// since the fix (pick another local port) is right here.
import { useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { digitsOnly, parsePortNumber } from "@shigomori/contracts/schemas";
import { Input } from "@shigomori/ui/primitives/input.tsx";
import { TONE_TEXT } from "@shigomori/ui/primitives/status-dot.tsx";
import { Switch } from "@shigomori/ui/primitives/switch.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { OpenLocalhostButtonView } from "./OpenLocalhostButtonView";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";

export function ForwardControlView({
  deviceLabel,
  remotePort,
  localPort,
  live,
  pending,
  connCount,
  listening,
  granted,
  error,
  onLocalPort,
  onToggle,
  className,
}: {
  deviceLabel: string;
  remotePort: number;
  // Where the listener is bound while live, the remembered preference
  // while off.
  localPort: number;
  live: boolean;
  // What is under way: a start, a stop, or a live forward moving to
  // another local port.
  pending: "start" | "stop" | "move" | null;
  // The forward's open conns, while live.
  connCount: number;
  // Whether a server is behind the port over there right now.
  listening: boolean;
  // Whether this device may drive verbs on the peer. A live forward can
  // always be switched off (that is a local act), but switching one on
  // opens a grant-gated conn over there.
  granted: boolean;
  error: string | null;
  // A new local port committed in the field.
  onLocalPort: (port: number) => void;
  onToggle: (on: boolean) => void;
  // The band's frame and inset, which the row decides (PortRowView).
  className?: string;
}) {
  // The field's uncommitted text, null while not editing.
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs the field to leave it, and that blur fires commit
  // synchronously, before the state reset lands: the flag is what
  // tells that blur to drop the draft rather than apply it.
  const abandoning = useRef(false);
  const shown = draft ?? String(localPort);

  const commit = () => {
    const abandoned = abandoning.current;
    abandoning.current = false;
    if (draft === null || abandoned) return;
    setDraft(null);
    const next = parsePortNumber(draft);
    if (next === undefined || next === localPort) return;
    onLocalPort(next);
  };

  // Why it can't be turned on, when it can't.
  const switchTip = live || granted ? undefined : peerReadOnlyNote();

  const state = describeState(
    pending,
    live ? { connCount } : undefined,
    listening,
  );

  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}
    >
      <div className="tabular flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <span>
          {deviceLabel}:{remotePort}
        </span>
        <ArrowRight aria-hidden className="size-3 shrink-0 opacity-60" />
        <span aria-hidden>localhost:</span>
        <Input
          inputMode="numeric"
          value={shown}
          aria-label={`Local port for ${remotePort}`}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(digitsOnly(event.target.value))}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              abandoning.current = true;
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
          className={cn(
            "h-6 w-16 px-1.5 text-center font-mono text-xs text-foreground tabular",
            live && "font-medium",
          )}
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span
          className={cn(
            "text-xs",
            state.serving
              ? cn("font-medium", TONE_TEXT.emerald)
              : TONE_TEXT.slate,
          )}
        >
          {state.word}
        </span>
        {/* A fixed-width slot so the spinner standing in for the switch
            does not shift the Open button beside it. */}
        <span className="flex w-8 shrink-0 items-center justify-center">
          {pending !== null ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <SimpleTooltip tip={switchTip}>
              <Switch
                checked={live}
                disabled={!live && !granted}
                aria-label={`Forward port ${remotePort}`}
                onCheckedChange={onToggle}
              />
            </SimpleTooltip>
          )}
        </span>
        <OpenLocalhostButtonView
          port={localPort}
          disabledReason={live ? undefined : "Switch the forward on to open it"}
        />
      </div>

      {error !== null && (
        <p className={cn("basis-full text-2xs leading-snug", TONE_TEXT.rose)}>
          {error}
        </p>
      )}
    </div>
  );
}

// The word beside the switch, and whether it reads as up (a settled
// forward with a server behind it).
function describeState(
  pending: "start" | "stop" | "move" | null,
  forward: { connCount: number } | undefined,
  listening: boolean,
): { word: string; serving: boolean } {
  if (pending === "start") return { word: "Starting", serving: false };
  if (pending === "stop") return { word: "Stopping", serving: false };
  if (pending === "move") return { word: "Moving", serving: false };
  if (forward === undefined) return { word: "Off", serving: false };
  // Open conns outrank the liveness poll, which lags a server that
  // just came up. The engine counts a conn only once its far end
  // opened, so a dial to a dead port never reads as one.
  if (!listening && forward.connCount === 0) {
    return { word: "Waiting for a server", serving: false };
  }
  return {
    word:
      forward.connCount > 0
        ? `Forwarding, ${forward.connCount} open`
        : "Forwarding",
    serving: true,
  };
}
