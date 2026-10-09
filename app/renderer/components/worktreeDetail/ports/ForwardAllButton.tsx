// A peer's port list's bulk actions (ForwardAllButtonView), one
// forward at a time.
import { useMutation } from "@tanstack/react-query";
import {
  errorMessageOf,
  isCommandRefusedError,
} from "@shigomori/contracts/errors";
import type { PortForwardWorktree } from "@shigomori/contracts/modules/portForward";
import type { WorktreePort } from "@shigomori/contracts/schemas";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { preferredLocalPort } from "@/hooks/config/useForwardLocalPort";
import {
  describeForwardError,
  usePortForwards,
} from "@/hooks/remote/usePortForwards";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { notifyError } from "@/lib/toast";
import {
  type ForwardAllMode,
  ForwardAllButtonView,
} from "./ForwardAllButtonView";

type Mode = ForwardAllMode;

export function ForwardAllButton({
  deviceId,
  worktree,
  ports,
  granted,
}: {
  deviceId: string;
  worktree: PortForwardWorktree;
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
            await window.api.portForward.start({
              deviceId,
              worktree,
              ...target,
            });
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
            await window.api.portForward.stop({ forwardId: forward.forwardId });
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
  // Why Start is off, if it is. Stop is never off for a reason of its own.
  const startBlocker = !granted
    ? peerReadOnlyNote()
    : toStart.length === 0
      ? "No ports to forward"
      : undefined;
  const canStop = toStop.length > 0;
  const modes: Mode[] = canStop
    ? canStart
      ? ["start", "stop"]
      : ["stop"]
    : ["start"];

  return (
    <ForwardAllButtonView
      modes={modes}
      runningMode={bulk.isPending ? (bulk.variables ?? null) : null}
      canStart={canStart}
      startBlocker={startBlocker}
      waiting={configQuery.isPending}
      onRun={(mode) => bulk.mutate(mode)}
    />
  );
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
