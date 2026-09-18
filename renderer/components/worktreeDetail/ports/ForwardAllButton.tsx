// The remote Ports dialog's bulk actions: forward every listed port in
// one go, and stop every forward the dialog lists. A port with nothing
// listening yet is started too: the engine binds the forward anyway and
// it reaches the server once one comes up. Each start lands on the
// local port the row remembers (preferredLocalPort), so the bulk action
// and the switches agree on where a port goes. Starts run one at a
// time: each opens a probe channel on the peer, and the order makes a
// local-port collision between two rows deterministic. The rows reflect
// the outcome live off the engine's broadcast. Failures fold into one
// toast per action rather than one per port.
import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Power, PowerOff } from "lucide-react";
import { errorMessageOf } from "@shared/errors";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import type { WorktreePort } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { preferredLocalPort } from "@/hooks/config/useForwardLocalPort";
import {
  describeForwardError,
  usePortForwards,
} from "@/hooks/remote/usePortForwards";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { pluralize } from "@/lib/pluralize";
import { notifyError } from "@/lib/toast";

type Mode = "start" | "stop";

const MODE_FACE: Record<Mode, { icon: ReactNode; label: string }> = {
  start: { icon: <Power />, label: "Forward all" },
  stop: { icon: <PowerOff />, label: "Stop all" },
};

export function ForwardAllButton({
  deviceId,
  ports,
  granted,
}: {
  deviceId: string;
  ports: readonly WorktreePort[];
  granted: boolean;
}) {
  const { forwards } = usePortForwards(deviceId);
  const configQuery = useClientConfig();
  const forwarded = new Set(forwards.map((forward) => forward.remotePort));
  const listed = new Set(ports.map((entry) => entry.port));
  const toStart = ports.filter((entry) => !forwarded.has(entry.port));
  const toStop = forwards.filter((forward) => listed.has(forward.remotePort));

  const bulk = useMutation({
    mutationFn: async (action: Mode) => {
      const failures: string[] = [];
      if (action === "start") {
        for (const entry of toStart) {
          const target = {
            remotePort: entry.port,
            localPort: preferredLocalPort(
              configQuery.data,
              deviceId,
              entry.port,
            ),
          };
          try {
            // oxlint-disable-next-line no-await-in-loop -- one probe channel at a time, in list order (see the header).
            await window.api.portForward.start({ deviceId, ...target });
          } catch (error) {
            // A refusal already surfaces centrally.
            if (!isCommandRefusedError(error)) {
              failures.push(describeForwardError(error, target));
            }
          }
        }
        reportFailures("Couldn't forward", toStart.length, failures);
      } else {
        for (const forward of toStop) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- same pacing as the starts.
            await window.api.portForward.stop(forward.forwardId);
          } catch (error) {
            failures.push(errorMessageOf(error));
          }
        }
        reportFailures("Couldn't stop forwarding", toStop.length, failures);
      }
    },
  });

  // Start is the resting face, shown alone until something is
  // forwarded. Stop joins it as soon as there is a forward to stop, and
  // stands alone once starting is off the table (everything forwarded,
  // or no grant). The two do not take turns: a listed port that cannot
  // bind on this machine stays startable forever, and must not keep the
  // stop out of reach. Stopping is a local act, so it never needs the
  // grant.
  const canStart = granted && toStart.length > 0;
  const canStop = toStop.length > 0;
  const modes: Mode[] = canStop
    ? canStart
      ? ["start", "stop"]
      : ["stop"]
    : ["start"];

  return (
    <>
      {modes.map((mode) => {
        const running = bulk.isPending && bulk.variables === mode;
        const face = running
          ? {
              icon: <Loader2 className="animate-spin" />,
              label: mode === "start" ? "Forwarding…" : "Stopping…",
            }
          : MODE_FACE[mode];
        return (
          <SimpleTooltip
            key={mode}
            tip={
              bulk.isPending
                ? undefined
                : describeTip(mode, toStart.length, toStop.length, granted)
            }
          >
            {/* The span is the trigger: a disabled button dispatches no
                pointer events, and disabled is when the tip matters. */}
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  bulk.isPending ||
                  configQuery.isPending ||
                  (mode === "start" && !canStart)
                }
                onClick={() => bulk.mutate(mode)}
              >
                {face.icon}
                {face.label}
              </Button>
            </span>
          </SimpleTooltip>
        );
      })}
    </>
  );
}

function describeTip(
  mode: Mode,
  toStart: number,
  toStop: number,
  granted: boolean,
): string {
  if (mode === "stop") return `Stop ${pluralize(toStop, "forward")}`;
  if (!granted) return peerReadOnlyNote();
  if (toStart === 0) return "No ports to forward";
  return `Forward ${pluralize(toStart, "port")}`;
}

// One toast for the whole action: the single failure in the engine's
// words, several as a count with the first reason under it.
function reportFailures(
  title: string,
  total: number,
  failures: string[],
): void {
  if (failures.length === 0) return;
  if (failures.length === 1) {
    notifyError(`${title} the port`, failures[0]);
  } else {
    notifyError(`${title} ${failures.length} of ${total} ports`, failures[0]);
  }
}
