import {
  DestinationScope,
  useDestinationScope,
  useHostScope,
} from "@/hooks/remote/useHostScope";
import { useDeviceIcon } from "@/hooks/remote/useRemoteDevices";
import { useCreatePlan } from "./createPlan";
import { type PullProgressProps, PullProgressView } from "./PullProgressView";

// The create's rows read the destination's project while the dialog
// sits under the source's scope, so the view re-pins itself.
export function PullProgress(props: PullProgressProps) {
  return (
    <DestinationScope>
      <Progress {...props} />
    </DestinationScope>
  );
}

function Progress(props: PullProgressProps) {
  const sourceIcon = useDeviceIcon(useHostScope().deviceId);
  const destinationIcon = useDeviceIcon(useDestinationScope().deviceId);
  const plan = useCreatePlan(props.target.project);
  return (
    <PullProgressView
      {...props}
      sourceIcon={sourceIcon}
      destinationIcon={destinationIcon}
      plan={plan}
    />
  );
}
