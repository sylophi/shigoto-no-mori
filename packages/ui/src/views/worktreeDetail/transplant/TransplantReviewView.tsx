// The transplant review's own sections, drawn (TransplantReview.tsx
// binds them): the uncommitted changes that travel, and the landing
// project's carry-over.
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { DiffStats } from "../../../primitives/diff-stats.tsx";
import { RowTag } from "../../../primitives/row-tag.tsx";
import { SectionHeading } from "../../../primitives/section-heading.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import type { IndexEntry } from "../../../lib/indexEntry.ts";
import { cn } from "../../../lib/utils.ts";
import {
  CARD_NOTE,
  CardListView,
  CardSkeletonView,
  MAX_LIST_ROWS as MAX_ROWS,
} from "../flow/FlowChromeView.tsx";

export function TransplantDetailsView({
  changes,
  carryOver,
}: {
  // The changed files, on a dirty tree.
  changes: ReactNode;
  // The landing project's carry-over, once there is one.
  carryOver: ReactNode;
}) {
  return (
    <>
      {changes && (
        <section className="space-y-2">
          <SectionHeading>
            Uncommitted changes
            <span className="ml-1.5 font-normal tracking-normal normal-case">
              (re-applied on arrival)
            </span>
          </SectionHeading>
          {changes}
        </section>
      )}
      {carryOver}
    </>
  );
}

export function ChangedFilesView({
  files,
  isPending,
  isError,
}: {
  files: IndexEntry[];
  isPending: boolean;
  isError: boolean;
}) {
  if (isPending) return <CardSkeletonView rows={2} />;
  if (isError) {
    return (
      <p className={CARD_NOTE}>
        The diff could not be read right now. The changes travel all the same.
      </p>
    );
  }
  if (files.length === 0) {
    return <p className={CARD_NOTE}>No uncommitted changes to list.</p>;
  }
  return (
    <CardListView total={files.length}>
      {files.slice(0, MAX_ROWS).map((entry) => {
        const { mark, stats } = entry;
        return (
          <li key={entry.key} className="flex items-center gap-2">
            <SimpleTooltip tip={mark.label}>
              <span
                aria-label={mark.label}
                className={cn("w-3 shrink-0 font-semibold", mark.className)}
              >
                {mark.mark}
              </span>
            </SimpleTooltip>
            <SimpleTooltip whenTruncated tip={entry.path}>
              <span className="min-w-0 flex-1 truncate">{entry.path}</span>
            </SimpleTooltip>
            {stats && (
              <DiffStats
                additions={stats.additions}
                deletions={stats.deletions}
              />
            )}
          </li>
        );
      })}
    </CardListView>
  );
}

// The landing project's carry-over (../flow/createPlan.ts), as the
// review's card.
export function CarryOverListView({
  projectName,
  thisDeviceLabel,
  rows,
  isPending,
}: {
  projectName: string;
  thisDeviceLabel: string;
  rows: { path: string; tag: string }[];
  isPending: boolean;
}) {
  return (
    <section className="space-y-2">
      <SectionHeading>
        Carry-over files
        <span className="ml-1.5 font-normal tracking-normal normal-case">
          (from {projectName} on {thisDeviceLabel})
        </span>
      </SectionHeading>
      {isPending ? (
        <CardSkeletonView />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None configured.</p>
      ) : (
        <CardListView total={rows.length}>
          {rows.slice(0, MAX_ROWS).map((row) => (
            <li key={row.path} className="flex items-center gap-2">
              <Check
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground"
              />
              <SimpleTooltip whenTruncated tip={row.path}>
                <span className="min-w-0 flex-1 truncate">{row.path}</span>
              </SimpleTooltip>
              <RowTag>{row.tag}</RowTag>
            </li>
          ))}
        </CardListView>
      )}
    </section>
  );
}
