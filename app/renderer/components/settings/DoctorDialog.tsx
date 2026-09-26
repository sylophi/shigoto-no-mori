import { useState } from "react";
import { Loader2, RefreshCw, Stethoscope, Wrench } from "lucide-react";
import { errorMessageOf } from "@shared/errors";
import type { DoctorFinding, DoctorReport } from "@shared/ipc/modules/cli";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { ModalShell } from "@/components/ui/modal-shell";
import { RowTag } from "@/components/ui/row-tag";
import { Skeleton } from "@/components/ui/skeleton";
import {
  StatusDot,
  TONE_PILL,
  type StatusTone,
} from "@/components/ui/status-dot";
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
import { pluralize } from "@/lib/pluralize";
import {
  FlowBody,
  FlowFooter,
  FlowHeader,
} from "../worktreeDetail/flow/FlowChrome";

// `sm doctor` for the scoped device, behind Settings' health check
// button: the same checklist a terminal prints (install, data folder,
// projects), run by that machine's own CLI each time the dialog opens.
// The CLI owns every check and every word, so this only draws the
// findings. Problems lead, and the passing checks fold away behind a
// toggle. Repair runs `--fix --yes`, which only ever applies the
// repairs the CLI calls unambiguous (the rows tagged repairable),
// behind a click-again confirm.
export function DoctorDialog({ onClose }: { onClose: () => void }) {
  const { deviceId, remote } = useHostScope();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const { data, error, isFetching, refetch } = useDoctorReport({ run: true });
  const repair = useDoctorRepair();
  const repairing = useDoctorRepairing();
  // Some repairs delete (a project's registration and state, locks).
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  const [showPassing, setShowPassing] = useState(false);

  // The last run's report stays cached, and a re-run must not pass it
  // off as this one's answer.
  const report = isFetching || repairing || error ? undefined : data;
  const problems = report?.checks.filter((check) => check.status !== "ok");
  const passing = report?.checks.filter((check) => check.status === "ok");
  const repairable = problems?.filter((check) => check.repairable).length ?? 0;
  const busy = isFetching || repairing;

  return (
    <ModalShell
      onClose={onClose}
      popoverClassName="flex max-h-[85vh] max-w-2xl flex-col"
    >
      <FlowHeader
        tint={TONE_PILL[report ? summaryTone(report) : "slate"]}
        icon={Stethoscope}
        title={remote ? `Health check on ${deviceLabel}` : "Health check"}
        onClose={onClose}
      >
        <p>
          {report ? (
            summaryLabel(report)
          ) : error ? (
            "Couldn't run the check"
          ) : repairing ? (
            "Repairing…"
          ) : (
            <>
              Running <span className="font-mono">sm doctor</span>…
            </>
          )}
        </p>
      </FlowHeader>
      <FlowBody>
        <div className="space-y-4">
          {error && (
            <ErrorBanner
              message={errorMessageOf(error)}
              title="Couldn't run the health check"
            />
          )}
          {repair.error && (
            <ErrorBanner
              message={repair.error.message}
              title="Couldn't repair"
            />
          )}
          {report && report.repairFailed.length > 0 && (
            <ErrorBanner
              message={report.repairFailed.join("\n")}
              title="Couldn't repair"
            />
          )}
          {!report && !error && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}

          {report && report.repaired.length > 0 && (
            <ul className="space-y-1">
              {report.repaired.map((label) => (
                <li key={label}>
                  <StatusDot
                    tone="emerald"
                    label={<span className="text-xs">Repaired: {label}</span>}
                  />
                </li>
              ))}
            </ul>
          )}

          {problems && problems.length > 0 && (
            <ul className="space-y-3">
              {problems.map((check) => (
                <ProblemRow key={findingKey(check)} check={check} />
              ))}
            </ul>
          )}

          {passing && passing.length > 0 && (
            <div className="space-y-2">
              <Button
                variant="link"
                size="xs"
                className="px-0"
                aria-expanded={showPassing}
                onClick={() => setShowPassing((shown) => !shown)}
              >
                {showPassing
                  ? "Hide passing checks"
                  : `Show ${pluralize(passing.length, "passing check")}`}
              </Button>
              {showPassing && (
                <ul className="space-y-1">
                  {passing.map((check) => (
                    <li
                      key={findingKey(check)}
                      className="flex items-baseline gap-2 text-xs"
                    >
                      <StatusDot tone="emerald" />
                      <span className="shrink-0 font-medium">
                        {check.title}
                      </span>
                      <span className="min-w-0 text-muted-foreground select-text">
                        <CliText text={check.detail} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </FlowBody>
      <FlowFooter
        note={
          repairable > 0
            ? "Repair applies only the fixes marked repairable. The rest need a decision the check can't make."
            : undefined
        }
      >
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void refetch()}
        >
          <RefreshCw className={isFetching ? "animate-spin" : undefined} />
          Check again
        </Button>
        {repairable > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-pressed={armed}
            onClick={() => trigger(() => repair.mutate())}
          >
            {repairing ? (
              <Loader2 aria-hidden className="animate-spin" />
            ) : (
              <Wrench />
            )}
            {repairing
              ? "Repairing…"
              : armed
                ? "Click again to repair"
                : `Repair ${repairable}`}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </FlowFooter>
    </ModalShell>
  );
}

function ProblemRow({ check }: { check: DoctorFinding }) {
  return (
    <li className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot
          tone={check.status === "fail" ? "rose" : "amber"}
          label={<span className="font-medium">{check.title}</span>}
        />
        <span className="text-xs text-muted-foreground">{check.group}</span>
        {check.repairable && <RowTag>Repairable</RowTag>}
      </div>
      <p className="pl-3 text-xs text-muted-foreground select-text">
        <CliText text={check.detail} />
      </p>
      {check.fix && (
        <p className="pl-3 text-xs select-text">
          <CliText text={check.fix} />
        </p>
      )}
    </li>
  );
}

// The CLI writes for a terminal, where a command is set off in
// backticks. Here the command reads as code instead.
function CliText({ text }: { text: string }) {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      // oxlint-disable-next-line react/no-array-index-key -- a fixed split, never reordered
      <span key={i} className="font-mono">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

// A project can hold several findings under one check id, each with
// its own detail.
function findingKey(check: DoctorFinding): string {
  return `${check.group}/${check.id}/${check.title}/${check.detail}`;
}

export function summaryTone(report: DoctorReport): StatusTone {
  if (report.summary.fail > 0) return "rose";
  if (report.summary.warn > 0) return "amber";
  return "emerald";
}

export function summaryLabel(report: DoctorReport): string {
  const { ok, warn, fail } = report.summary;
  if (warn === 0 && fail === 0) return `${pluralize(ok, "check")} passed`;
  const parts: string[] = [];
  if (fail > 0) parts.push(`${fail} failed`);
  if (warn > 0) parts.push(pluralize(warn, "warning"));
  return parts.join(", ");
}
