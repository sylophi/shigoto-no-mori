// Step 1 of the transplant: what travels, what stays, and where it
// lands. The source half reads the device the page is scoped to (its
// diff, its PR, its ignored files). The destination half re-pins to
// the landing device (DestinationScope: this machine, or the peer a
// local worktree is being transplanted to), because carry-over and the
// folder come from the DESTINATION project's config, not the source's,
// and so does the pre-flight: a branch that device already holds fails
// the pull at step 2, so the review says so here and keeps Start off.
import { Check } from "lucide-react";
import type { Project, Worktree } from "@shared/schemas";
import { DiffStats } from "@/components/ui/diff-stats";
import { RowTag } from "@/components/ui/row-tag";
import { SectionHeading } from "@/components/ui/section-heading";
import { changeEntries } from "@/lib/patchFiles";
import { DestinationScope } from "@/hooks/remote/useHostScope";
import { useWorktreeChanges } from "@/hooks/worktrees/useWorktreeChanges";
import { cn } from "@/lib/utils";
import { useCarryOverRows } from "../flow/createPlan";
import { type PullReviewProps, PullReviewStep } from "../flow/PullReview";
import {
  CARD_NOTE,
  CardList,
  CardSkeleton,
  MAX_LIST_ROWS as MAX_ROWS,
} from "../flow/FlowChrome";

export function TransplantReview(props: PullReviewProps) {
  const { worktree, project, target, sourceDeviceLabel, thisDeviceLabel } =
    props;
  const dirty = worktree.changedCount > 0;
  return (
    <PullReviewStep
      {...props}
      heading="Destination"
      sourceNote="where it is now"
      idleNote={`Nothing on ${sourceDeviceLabel} is deleted until you say so at the last step.`}
      startLabel="Start transplant"
      beforeLeaveOut={
        <section className="space-y-2">
          <SectionHeading>
            Uncommitted changes
            <span className="ml-1.5 font-normal tracking-normal normal-case">
              {dirty ? "(re-applied on arrival)" : "(none)"}
            </span>
          </SectionHeading>
          {dirty ? (
            <ChangedFiles worktree={worktree} project={project} />
          ) : (
            <p className="text-xs text-muted-foreground">
              The tree is clean, so only the branch travels.
            </p>
          )}
        </section>
      }
      afterLeaveOut={
        target?.project && (
          <DestinationScope>
            <CarryOverList
              localProject={target.project}
              thisDeviceLabel={thisDeviceLabel}
            />
          </DestinationScope>
        )
      }
    />
  );
}

function ChangedFiles({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  // A one-shot preview: the list crosses the device link, so it is not
  // re-pulled on every focus the way the changes page's is. It is git
  // status rather than a patch, so untracked files are listed too.
  const {
    data: changed,
    isPending,
    isError,
  } = useWorktreeChanges(project.id, worktree.id, {
    refetchOnWindowFocus: false,
  });
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
// review's card. Under DestinationScope by the caller.
function CarryOverList({
  localProject,
  thisDeviceLabel,
}: {
  localProject: Project;
  thisDeviceLabel: string;
}) {
  const { rows, isPending } = useCarryOverRows(localProject);
  return (
    <section className="space-y-2">
      <SectionHeading>
        Carry-over files
        <span className="ml-1.5 font-normal tracking-normal normal-case">
          (from {localProject.name} on {thisDeviceLabel})
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
