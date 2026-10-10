import { useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Loader2,
  RefreshCw,
  Stethoscope,
  Wrench,
} from "lucide-react";
import { errorMessageOf } from "@shigomori/contracts/errors";
import type {
  DoctorFinding,
  DoctorReport,
} from "@shigomori/contracts/modules/cli";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { ErrorBanner } from "@shigomori/ui/primitives/error-banner.tsx";
import { RowTag } from "@shigomori/ui/primitives/row-tag.tsx";
import { SectionHeading } from "@shigomori/ui/primitives/section-heading.tsx";
import { Skeleton } from "@shigomori/ui/primitives/skeleton.tsx";
import {
  StatusDot,
  TONE_PILL,
  TONE_TEXT,
  type StatusTone,
} from "@shigomori/ui/primitives/status-dot.tsx";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@shigomori/ui/lib/utils.ts";
import {
  CARD,
  FlowBodyView,
  FlowFooterView,
  FlowHeaderView,
} from "../worktreeDetail/flow/FlowChromeView";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

// `sm doctor` for the scoped device, behind Settings' health check
// button: the same checklist a terminal prints (install, data folder,
// processes, projects), run by that machine's own CLI each time the
// dialog opens. The CLI owns every check and every word, so this only
// draws the findings: problems first, in the CLI's groups, with a
// project's several problems gathered under its name, and the passing
// checks folded away behind a toggle. Repair runs `--fix --yes`, which
// only ever applies the repairs the CLI calls unambiguous (the rows
// tagged repairable), behind a click-again confirm.
// The dialog's content (DoctorDialog puts it in a ModalShell).
export function DoctorDialogView({
  title,
  report,
  error,
  isFetching,
  repairing,
  repairError,
  armed,
  onRepair,
  onCheckAgain,
  onClose,
}: {
  title: string;
  // This run's report, undefined while it runs or after it failed.
  report: DoctorReport | undefined;
  error: Error | null;
  isFetching: boolean;
  repairing: boolean;
  repairError: string | undefined;
  // Some repairs delete (a project's registration and state, locks), so
  // the repair is asked for twice.
  armed: boolean;
  onRepair: () => void;
  onCheckAgain: () => void;
  onClose: () => void;
}) {
  const [showPassing, setShowPassing] = useState(false);
  const problems = report?.checks.filter((check) => check.status !== "ok");
  const passing = report?.checks.filter((check) => check.status === "ok");
  const repairable = problems?.filter((check) => check.repairable).length ?? 0;
  const busy = isFetching || repairing;

  return (
    <>
      <FlowHeaderView
        tint={TONE_PILL[report ? summaryTone(report) : "slate"]}
        icon={Stethoscope}
        title={title}
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
      </FlowHeaderView>
      <FlowBodyView>
        <div className="space-y-5">
          {error && (
            <ErrorBanner
              message={errorMessageOf(error)}
              title="Couldn't run the health check"
            />
          )}
          {repairError !== undefined && (
            <ErrorBanner message={repairError} title="Couldn't repair" />
          )}
          {report && report.repairFailed.length > 0 && (
            <ErrorBanner
              message={report.repairFailed.join("\n")}
              title="Couldn't repair"
            />
          )}
          {!report && !error && <LoadingRows />}

          {report && report.repaired.length > 0 && (
            <div className={cn(CARD, "space-y-1.5")}>
              <p className="flex items-center gap-2 text-sm font-medium">
                <CircleCheck className={cn("size-4", TONE_TEXT.emerald)} />
                Repaired
              </p>
              <ul className="space-y-0.5 pl-6 text-xs text-muted-foreground">
                {report.repaired.map((label) => (
                  <li key={label}>{asSentence(label)}</li>
                ))}
              </ul>
            </div>
          )}

          {problems && problems.length === 0 && (
            <AllClear checks={passing?.length ?? 0} />
          )}
          {problems &&
            groupFindings(problems).map(({ group, clusters }) => (
              <section key={group} className="space-y-2">
                <SectionHeading>{groupLabel(group)}</SectionHeading>
                <ul className={cn(CARD, "divide-y divide-border p-0")}>
                  {clusters.map((cluster) => (
                    <ProblemCluster key={cluster.title} cluster={cluster} />
                  ))}
                </ul>
              </section>
            ))}

          {passing && passing.length > 0 && (
            <div className="space-y-2">
              <Button
                variant="ghost"
                size="xs"
                className="-ml-2 text-muted-foreground"
                aria-expanded={showPassing}
                onClick={() => setShowPassing((shown) => !shown)}
              >
                <ChevronRight
                  className={cn(
                    "transition-transform",
                    showPassing && "rotate-90",
                  )}
                />
                {showPassing
                  ? "Hide passing checks"
                  : `Show ${pluralize(passing.length, "passing check")}`}
              </Button>
              {showPassing && <PassingList checks={passing} />}
            </div>
          )}
        </div>
      </FlowBodyView>
      <FlowFooterView
        note={
          repairable > 0
            ? `Repair fixes the ${pluralize(repairable, "problem")} marked repairable. The rest need a decision only you can make.`
            : undefined
        }
      >
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onCheckAgain}
        >
          <RefreshCw className={isFetching ? "animate-spin" : undefined} />
          Check again
        </Button>
        {repairable > 0 && (
          <Button
            size="sm"
            disabled={busy}
            aria-pressed={armed}
            onClick={onRepair}
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
      </FlowFooterView>
    </>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-24" />
      <div className={cn(CARD, "space-y-2.5")}>
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

function AllClear({ checks }: { checks: number }) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <span
        className={cn(
          "flex size-10 items-center justify-center rounded-full",
          TONE_PILL.emerald,
        )}
      >
        <CircleCheck className="size-5" />
      </span>
      <p className="text-sm font-medium">Everything looks healthy</p>
      <p className="text-xs text-muted-foreground">
        All {pluralize(checks, "check")} passed.
      </p>
    </div>
  );
}

// One title's problems: a project's several findings read as one block
// under its name instead of the name repeated on every line.
function ProblemCluster({ cluster }: { cluster: Cluster }) {
  const failed = cluster.findings.some((check) => check.status === "fail");
  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <StatusIcon status={failed ? "fail" : "warn"} />
        <SimpleTooltip whenTruncated tip={cluster.title}>
          <span className="min-w-0 truncate text-sm font-medium">
            {cluster.title}
          </span>
        </SimpleTooltip>
        {cluster.findings.length > 1 && (
          <span className="text-xs text-muted-foreground">
            {pluralize(cluster.findings.length, "problem")}
          </span>
        )}
      </div>
      <ul className="space-y-2 pl-6">
        {cluster.findings.map((check) => (
          <ProblemItem
            key={findingKey(check)}
            check={check}
            marked={cluster.findings.length > 1}
          />
        ))}
      </ul>
    </li>
  );
}

// With several problems under one title each gets its own status mark,
// since a failure and a warning can sit side by side.
function ProblemItem({
  check,
  marked,
}: {
  check: DoctorFinding;
  marked: boolean;
}) {
  return (
    <li className="relative space-y-0.5 text-xs">
      {marked && (
        <StatusDot
          tone={statusTone(check.status)}
          className="absolute top-0 -left-3.5 text-xs"
        />
      )}
      <p className="break-words select-text">
        <CliText text={asSentence(check.detail)} />
        {check.repairable && <RepairableTag />}
      </p>
      {check.fix && (
        <p className="break-words text-muted-foreground select-text">
          <CliText text={check.fix} />
        </p>
      )}
    </li>
  );
}

// Marks what the footer's Repair button will take care of, in the
// button's own icon.
function RepairableTag() {
  return (
    <RowTag className="ml-1.5 inline-flex items-center gap-1 align-middle whitespace-nowrap select-none">
      <Wrench aria-hidden className="size-2.5" />
      Repairable
    </RowTag>
  );
}

function PassingList({ checks }: { checks: DoctorFinding[] }) {
  const groups = [...new Set(checks.map((check) => check.group))];
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <section key={group} className="space-y-1">
          <SectionHeading className="text-2xs">
            {groupLabel(group)}
          </SectionHeading>
          <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {checks
              .filter((check) => check.group === group)
              .map((check) => (
                <div key={findingKey(check)} className="contents">
                  <dt className="flex min-w-0 items-center gap-1.5 font-medium">
                    <CircleCheck
                      className={cn("size-3 shrink-0", TONE_TEXT.emerald)}
                    />
                    <SimpleTooltip whenTruncated tip={check.title}>
                      <span className="truncate">{check.title}</span>
                    </SimpleTooltip>
                  </dt>
                  <dd className="min-w-0 break-words text-muted-foreground select-text">
                    <CliText text={check.detail} />
                  </dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  const failed = status === "fail";
  const Icon = failed ? CircleAlert : AlertTriangle;
  const label = failed ? "Failed" : "Warning";
  return (
    <SimpleTooltip tip={label}>
      <Icon
        aria-label={label}
        className={cn("size-4 shrink-0", TONE_TEXT[statusTone(status)])}
      />
    </SimpleTooltip>
  );
}

// A problem's tone: a failure reads rose, anything else a warning.
function statusTone(status: string): StatusTone {
  return status === "fail" ? "rose" : "amber";
}

// The CLI writes for a terminal, where a command is set off in
// backticks. Here the command reads as code instead.
function CliText({ text }: { text: string }) {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code
        // oxlint-disable-next-line react/no-array-index-key -- a fixed split, never reordered
        key={i}
        className="rounded bg-muted box-decoration-clone px-1 py-px font-mono text-[0.95em]"
      >
        {part}
      </code>
    ) : (
      part
    ),
  );
}

// The CLI's details read as checklist fragments after a title column
// ("not installed, so ..."). Here they stand alone as sentences. Only a
// plain leading letter is raised: a command or a path is left exactly
// as it would be pasted.
function asSentence(text: string): string {
  return /^[a-z]/.test(text)
    ? text.charAt(0).toUpperCase() + text.slice(1)
    : text;
}

type Cluster = { title: string; findings: DoctorFinding[] };

// The CLI's groups in the order it sends them, each with its findings
// gathered by title (the project name, for the Projects group) in
// first-seen order.
function groupFindings(
  checks: DoctorFinding[],
): { group: string; clusters: Cluster[] }[] {
  const groups = new Map<string, Map<string, DoctorFinding[]>>();
  for (const check of checks) {
    let clusters = groups.get(check.group);
    if (!clusters) {
      clusters = new Map();
      groups.set(check.group, clusters);
    }
    const findings = clusters.get(check.title) ?? [];
    findings.push(check);
    clusters.set(check.title, findings);
  }
  return [...groups].map(([group, clusters]) => ({
    group,
    clusters: [...clusters].map(([title, findings]) => ({ title, findings })),
  }));
}

// The CLI's group titles are terminal words. The app calls the data dir
// the data folder everywhere else.
function groupLabel(group: string): string {
  return group === "Data dir" ? "Data folder" : group;
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
