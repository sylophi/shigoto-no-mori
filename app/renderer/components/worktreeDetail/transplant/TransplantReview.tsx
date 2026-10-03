// Step 1 of the transplant: what travels, what stays, and where it
// lands. The source half reads the device the page is scoped to (its
// diff, its PR, its ignored files). The destination half re-pins to
// the landing device (DestinationScope: this machine, or the peer a
// local worktree is being transplanted to), because carry-over and the
// folder come from the DESTINATION project's config, not the source's,
// and so does the pre-flight: a branch that device already holds fails
// the pull at step 2, so the review says so here and keeps Start off.
// The sections' look is TransplantReviewView.tsx.
import type { Project, Worktree } from "@shared/schemas";
import { DestinationScope } from "@/hooks/remote/useHostScope";
import { useWorktreeChanges } from "@/hooks/worktrees/useWorktreeChanges";
import { useCarryOverRows } from "../flow/createPlan";
import { type PullReviewProps, PullReviewStep } from "../flow/PullReview";
import {
  CarryOverListView,
  ChangedFilesView,
  TRANSPLANT_REVIEW,
  UncommittedChangesView,
} from "./TransplantReviewView";

export function TransplantReview(props: PullReviewProps) {
  const { worktree, project, target, sourceDeviceLabel, thisDeviceLabel } =
    props;
  return (
    <PullReviewStep
      {...props}
      heading={TRANSPLANT_REVIEW.heading}
      sourceNote={TRANSPLANT_REVIEW.sourceNote}
      idleNote={TRANSPLANT_REVIEW.idleNote(sourceDeviceLabel)}
      startLabel={TRANSPLANT_REVIEW.startLabel}
      beforeLeaveOut={
        <UncommittedChangesView dirty={worktree.changedCount > 0}>
          <ChangedFiles worktree={worktree} project={project} />
        </UncommittedChangesView>
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
  return (
    <ChangedFilesView
      changed={changed}
      isPending={isPending}
      isError={isError}
    />
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
    <CarryOverListView
      projectName={localProject.name}
      thisDeviceLabel={thisDeviceLabel}
      rows={rows}
      isPending={isPending}
    />
  );
}
