// Step 1 of the transplant: what travels, what stays, and where it
// lands. The source half reads the device the page is scoped to (its
// diff, its PR, its ignored files). The destination half re-pins to
// the landing device (DestinationScope: this machine, or the peer a
// local worktree is being transplanted to), because carry-over and the
// folder come from the DESTINATION project's config, not the source's,
// and so does the pre-flight: a branch that device already holds fails
// the pull at step 2, so the review says so here and keeps Start off.
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { changeEntries } from "@/lib/patchFiles";
import { useWorktreeChanges } from "@/hooks/worktrees/useWorktreeChanges";
import { DestinationScope } from "@/hooks/remote/useHostScope";
import { useCarryOverRows } from "../flow/createPlan";
import { type PullReviewProps, PullReviewStep } from "../flow/PullReview";
import {
  CarryOverListView,
  ChangedFilesView,
  TransplantDetailsView,
} from "@shigomori/ui/views/worktreeDetail/transplant/TransplantReviewView.tsx";

export function TransplantReview(props: PullReviewProps) {
  const { worktree, project, target, sourceDeviceLabel, thisDeviceLabel } =
    props;
  const dirty = worktree.changedCount > 0;
  return (
    <PullReviewStep
      {...props}
      link="move"
      sourceHeading="Source"
      destinationHeading="Destination"
      idleNote={`Nothing on ${sourceDeviceLabel} is deleted until you say so at the last step.`}
      startLabel="Start transplant"
      details={
        (dirty || target?.project) && (
          <TransplantDetailsView
            changes={
              dirty && <ChangedFiles worktree={worktree} project={project} />
            }
            carryOver={
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
      files={changeEntries(changed ?? [])}
      isPending={isPending}
      isError={isError}
    />
  );
}

// Under DestinationScope by the caller.
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
