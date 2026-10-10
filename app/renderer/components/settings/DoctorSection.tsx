import { useState } from "react";
import { useDoctorReport } from "@/hooks/cli/useDoctor";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { DoctorDialog } from "./DoctorDialog";
import { DoctorSectionView } from "./DoctorSectionView";

// The health check's section (DoctorSectionView) on whichever device it
// is mounted under, with the last run's verdict.
export function DoctorSection() {
  const { remote } = useHostScope();
  const [open, setOpen] = useState(false);
  const { data: report, dataUpdatedAt } = useDoctorReport({ run: false });
  return (
    <DoctorSectionView
      remote={remote}
      report={report}
      checkedAt={dataUpdatedAt}
      onRun={() => setOpen(true)}
      dialog={open && <DoctorDialog onClose={() => setOpen(false)} />}
    />
  );
}
