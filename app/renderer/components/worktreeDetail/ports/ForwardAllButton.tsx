// A peer's port list's bulk actions (ForwardAllButtonView). A port with
// nothing listening yet is started too: the engine binds the forward
// anyway and it reaches the server once one comes up. Each start lands
// on the local port the row remembers (preferredLocalPort), so the bulk
// action and the switches agree on where a port goes. Starts run one at
// a time: each opens a probe channel on the peer, and the order makes a
// local-port collision between two rows deterministic. The rows reflect
// the outcome live off the engine's broadcast. Failures fold into one
// toast per action rather than one per port.
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
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
import { peerReadOnlyNote } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { notifyError } from "@/lib/toast";
import { pluralize } from "@shigomori/contracts/words";
import {
  type ForwardAllMode,
  ForwardAllButtonView,
} from "@shigomori/ui/views/worktreeDetail/ports/ForwardAllButtonView.tsx";
import { useApi } from "@/lib/runtime/pageApi";

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
  const api = useApi();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const { forwards } = usePortForwards(deviceId);
  const configQuery = useClientConfig();
  const forwarded = new Set(forwards.map((forward) => forward.remotePort));
  const listed = new Set(ports.map((entry) => entry.port));
  const toStart = ports.filter((entry) => !forwarded.has(entry.port));
  const toStop = forwards.filter((forward) => listed.has(forward.remotePort));

  const bulk = useMutation({
    mutationFn: async (action: Mode) => {
      const failures: string[] = [];
      let started = 0;
      let refusal: string | undefined;
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
            await api.run(
              api.portForward.start({
                deviceId,
                worktree,
                ...target,
              }),
            );
            started += 1;
          } catch (error) {
            const reason = describeForwardError(error, target, deviceLabel);
            // The peer refuses every port alike: the rest go unasked.
            if (isCommandRefusedError(error)) {
              refusal = reason;
              break;
            }
            failures.push(reason);
          }
        }
        // A refusal is why the rest went unforwarded, whatever failed
        // before it.
        reportFailures(
          "Couldn't forward",
          toStart.length,
          refusal === undefined ? failures.length : toStart.length - started,
          refusal ?? failures[0],
        );
      } else {
        for (const forward of toStop) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- same pacing as the starts.
            await api.run(
              api.portForward.stop({ forwardId: forward.forwardId }),
            );
          } catch (error) {
            failures.push(errorMessageOf(error));
          }
        }
        reportFailures(
          "Couldn't stop forwarding",
          toStop.length,
          failures.length,
          failures[0],
        );
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
    ? peerReadOnlyNote(deviceLabel)
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

// One toast for the whole action, with its reason under it: the port,
// every one of them, or how many of them did not go.
function reportFailures(
  title: string,
  total: number,
  failed: number,
  reason: string | undefined,
): void {
  if (failed === 0) return;
  const which =
    total === 1
      ? "the port"
      : failed === total
        ? `the ${pluralize(total, "port")}`
        : `${failed} of ${pluralize(total, "port")}`;
  notifyError(`${title} ${which}`, reason);
}
