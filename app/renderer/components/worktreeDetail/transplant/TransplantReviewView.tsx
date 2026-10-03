// The transplant review's own sections as plain views: the uncommitted
// changes that travel, and the landing project's carry-over.
// TransplantReview.tsx reads them for the live dialog.
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import type { ChangedFile } from "@shared/schemas";
import { DiffStats } from "@/components/ui/diff-stats";
import { RowTag } from "@/components/ui/row-tag";
import { SectionHeading } from "@/components/ui/section-heading";
import type { CarryOverItem } from "@/lib/carryOverPaths";
import { changeEntries } from "@/lib/patchFiles";
import { cn } from "@/lib/utils";
import {
  CARD_NOTE,
  CardList,
  CardSkeleton,
  MAX_LIST_ROWS as MAX_ROWS,
} from "../flow/FlowChromeView";

// The section over the changes: what the tree holds, and the list of
// it (ChangedFilesView) when it is dirty.
export function UncommittedChangesView({
  dirty,
  children,
}: {
  dirty: boolean;
  // The list, for a dirty tree.
  children?: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <SectionHeading>
        Uncommitted changes
        <span className="ml-1.5 font-normal tracking-normal normal-case">
          {dirty ? "(re-applied on arrival)" : "(none)"}
        </span>
      </SectionHeading>
      {dirty ? (
        children
      ) : (
        <p className="text-xs text-muted-foreground">
          The tree is clean, so only the branch travels.
        </p>
      )}
    </section>
  );
}

// The source's changes as git status reads them.
export type ChangedFilesState = {
  changed: readonly ChangedFile[] | undefined;
  isPending: boolean;
  isError: boolean;
};

export function ChangedFilesView({
  changed,
  isPending,
  isError,
}: ChangedFilesState) {
  if (isPending) return <CardSkeleton rows={2} />;
  if (isError) {
    return (
      <p className={CARD_NOTE}>
        The diff could not be read right now. The changes travel all the same.
      </p>
    );
  }
  const files = changeEntries(changed ?? []);
  if (files.length === 0) {
    return <p className={CARD_NOTE}>No uncommitted changes to list.</p>;
  }
  return (
    <CardList total={files.length}>
      {files.slice(0, MAX_ROWS).map((entry) => {
        const { mark, stats } = entry;
        return (
          <li key={entry.key} className="flex items-center gap-2">
            <span
              aria-label={mark.label}
              className={cn("w-3 shrink-0 font-semibold", mark.className)}
            >
              {mark.mark}
            </span>
            <span className="min-w-0 flex-1 truncate" title={entry.path}>
              {entry.path}
            </span>
            {stats && (
              <DiffStats
                additions={stats.additions}
                deletions={stats.deletions}
              />
            )}
          </li>
        );
      })}
    </CardList>
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
  // The landing project's name.
  projectName: string;
  thisDeviceLabel: string;
  rows: readonly CarryOverItem[];
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
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None configured.</p>
      ) : (
        <CardList total={rows.length}>
          {rows.slice(0, MAX_ROWS).map((row) => (
            <li key={row.path} className="flex items-center gap-2">
              <Check
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate" title={row.path}>
                {row.path}
              </span>
              <RowTag>{row.tag}</RowTag>
            </li>
          ))}
        </CardList>
      )}
    </section>
  );
}
