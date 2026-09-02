// The forward band under a remote port's header: on the left the
// mapping as a form, `<device>:<remote port> -> localhost:<field>`. On
// the right the switch with its state spelled out, and Open once the
// forward is up. The field is the local end. While the forward is off
// it shows the remembered preference (default: the same number as the
// remote port, the least surprising place for it to land). While it is
// on it shows where the listener actually bound, and committing a new
// number moves the listener there. Failures land under the band rather
// than in a toast, since the fix (pick another local port) is right
// here.
import { useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { digitsOnly, parsePortNumber } from "@shared/schemas";
import { Input } from "@/components/ui/input";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useForwardLocalPort } from "@/hooks/config/useForwardLocalPort";
import { usePortForwardControl } from "@/hooks/remote/usePortForwards";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { cn } from "@/lib/utils";
import { OpenLocalhostButton } from "./OpenLocalhostButton";

export function ForwardControl({
  deviceId,
  remotePort,
  granted,
}: {
  deviceId: string;
  remotePort: number;
  // Whether this device may drive verbs on the peer. A live forward can
  // always be switched off (that is a local act), but switching one on
  // opens a grant-gated conn over there.
  granted: boolean;
}) {
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const { forward, apply, isPending, error, clearError } =
    usePortForwardControl(deviceId, remotePort);
  const { localPort: preferred, setLocalPort } = useForwardLocalPort(
    deviceId,
    remotePort,
  );
  // The field's uncommitted text, null while not editing.
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs the field to leave it, and that blur fires commit
  // synchronously, before the state reset lands: the flag is what
  // tells that blur to drop the draft rather than apply it.
  const abandoning = useRef(false);
  const live = forward !== undefined;
  const localPort = live ? forward.localPort : preferred;
  const shown = draft ?? String(localPort);

  const commit = () => {
    const abandoned = abandoning.current;
    abandoning.current = false;
    if (draft === null || abandoned) return;
    setDraft(null);
    const next = parsePortNumber(draft);
    if (next === undefined || next === localPort) return;
    clearError();
    if (live) {
      // Remembered only once the listener has actually moved: a number
      // that cannot bind must not become the default every later
      // switch-on retries.
      apply(
        { on: true, localPort: next },
        { onSuccess: () => setLocalPort(next) },
      );
    } else {
      setLocalPort(next);
    }
  };

  const toggle = (on: boolean) => {
    clearError();
    if (on) apply({ on: true, localPort });
    else apply({ on: false });
  };

  const switchTip = live
    ? "Stop forwarding"
    : granted
      ? `Forward ${deviceLabel}:${remotePort} to localhost:${localPort}`
      : "Needs command access, granted from that device's Devices page";

  const state = describeState(isPending, forward);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border bg-muted/40 px-3 py-1.5">
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
            live && !isPending
              ? cn("font-medium", TONE_TEXT.emerald)
              : TONE_TEXT.slate,
          )}
        >
          {state}
        </span>
        {/* A fixed-width slot so the spinner standing in for the switch
            does not shift the Open button beside it. */}
        <span className="flex w-8 shrink-0 items-center justify-center">
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <SimpleTooltip tip={switchTip}>
              <Switch
                checked={live}
                disabled={!live && !granted}
                aria-label={`Forward port ${remotePort}`}
                onCheckedChange={toggle}
              />
            </SimpleTooltip>
          )}
        </span>
        <OpenLocalhostButton
          port={localPort}
          disabled={!live}
          disabledTip="Switch the forward on to open it"
        />
      </div>

      {error !== null && (
        <p
          className={cn("basis-full text-[11px] leading-snug", TONE_TEXT.rose)}
        >
          {error}
        </p>
      )}
    </div>
  );
}

// The word beside the switch.
function describeState(
  pending: boolean,
  forward: { connCount: number } | undefined,
): string {
  if (pending) return forward === undefined ? "Starting" : "Stopping";
  if (forward === undefined) return "Off";
  if (forward.connCount > 0) return `Forwarding, ${forward.connCount} open`;
  return "Forwarding";
}
