import type { ReactNode } from "react";
import type { DoctorReport } from "@shigomori/contracts/modules/cli";
import { Stethoscope } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { RelativeDate } from "@shigomori/ui/primitives/relative-date.tsx";
import { SectionIntro } from "@shigomori/ui/primitives/section-heading.tsx";
import { StatusDot } from "@shigomori/ui/primitives/status-dot.tsx";
import { summaryLabel, summaryTone } from "./DoctorDialogView";

// Settings' door to `sm doctor` on whichever device the section is
// mounted under. The checklist itself lives in the dialog, which runs
// it on open. The section only repeats the last run's verdict: the
// dialog's, or for this machine the app's own daily run
// (useDoctorWatch).
export function DoctorSectionView({
  remote,
  report,
  checkedAt,
  onRun,
  dialog,
}: {
  // A peer's section: only this machine runs its check daily.
  remote: boolean;
  // The last run's report, and when it came.
  report: DoctorReport | undefined;
  checkedAt: number;
  onRun: () => void;
  // The checklist (DoctorDialog), while it is open.
  dialog: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <SectionIntro title="Health check">
        Checks this machine&apos;s install, its data folder and every project,
        the same as <span className="font-mono">sm doctor</span> in a terminal.
        {remote ? " " : " The app runs it once a day. "}
        Nothing changes unless you repair.
      </SectionIntro>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={onRun}>
          <Stethoscope />
          Run health check
        </Button>
        {report && (
          <StatusDot
            tone={summaryTone(report)}
            label={
              <span className="text-xs text-muted-foreground">
                Last check{" "}
                <RelativeDate date={new Date(checkedAt).toISOString()} />:{" "}
                {summaryLabel(report)}
              </span>
            }
          />
        )}
      </div>
      {dialog}
    </section>
  );
}
