import { useState } from "react";
import { Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionIntro } from "@/components/ui/section-heading";
import { StatusDot } from "@/components/ui/status-dot";
import { useDoctorReport } from "@/hooks/cli/useDoctor";
import { DoctorDialog, summaryLabel, summaryTone } from "./DoctorDialog";

// Settings' door to `sm doctor` on whichever device the section is
// mounted under. The checklist itself lives in the dialog, which runs
// it on open. The section only repeats the last run's verdict.
export function DoctorSection() {
  const [open, setOpen] = useState(false);
  const { data: report } = useDoctorReport({ run: false });

  return (
    <section className="space-y-3">
      <SectionIntro title="Health check">
        Checks this machine&apos;s install, its data folder and every project,
        the same as <span className="font-mono">sm doctor</span> in a terminal.
        Nothing changes unless you repair.
      </SectionIntro>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Stethoscope />
          Run health check
        </Button>
        {report && (
          <StatusDot
            tone={summaryTone(report)}
            label={
              <span className="text-xs text-muted-foreground">
                Last check: {summaryLabel(report)}
              </span>
            }
          />
        )}
      </div>
      {open && <DoctorDialog onClose={() => setOpen(false)} />}
    </section>
  );
}
