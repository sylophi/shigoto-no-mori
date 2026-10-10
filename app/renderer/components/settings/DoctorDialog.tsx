import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import {
  useDoctorRepair,
  useDoctorRepairing,
  useDoctorReport,
} from "@/hooks/cli/useDoctor";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { DoctorDialogView } from "@shigomori/ui/views/settings/DoctorDialogView.tsx";

// `sm doctor` for the scoped device (DoctorDialogView), run by that
// machine's own CLI each time the dialog opens.
export function DoctorDialog({ onClose }: { onClose: () => void }) {
  const { deviceId, remote } = useHostScope();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const { data, error, isFetching, refetch } = useDoctorReport({ run: true });
  const repair = useDoctorRepair();
  const repairing = useDoctorRepairing();
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  const title = remote ? `Health check on ${deviceLabel}` : "Health check";
  return (
    <ModalShell label={title} onClose={onClose} popoverClassName="max-w-2xl">
      <DoctorDialogView
        title={title}
        // The last run's report stays cached, and a re-run must not pass
        // it off as this one's answer.
        report={isFetching || repairing || error ? undefined : data}
        error={error}
        isFetching={isFetching}
        repairing={repairing}
        repairError={repair.error?.message}
        armed={armed}
        onRepair={() => trigger(() => repair.mutate())}
        onCheckAgain={() => void refetch()}
        onClose={onClose}
      />
    </ModalShell>
  );
}
