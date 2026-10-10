// Where a move lands when the destination has no checkout of the repo:
// every flow (a transplant or a mirror, either way round) clones it
// there first, into a folder the review names and the user can change.
// The default mirrors the source's own layout, the source's path with
// its home swapped for the destination's, so the two machines end up
// alike without a pick. A path outside the source's home falls back to
// where the destination keeps its repos (shared/cloneDestination.ts,
// which the CLI's send reads too). The mutation gets the pair as the
// move's `cloneInto`. The source is the device the dialog sits under, the
// destination the one DestinationScope names (this machine unless the
// flow goes to a peer).
//
// The landing target is the one fact every piece of a flow reads:
// the project the copy lands in, or the clone that makes one, or
// nothing yet (a flow to a peer with no device picked, which Start
// waits on). Made once per flow (useLandingTarget) and handed down.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SyncCloneInto } from "@shigomori/contracts/modules/sync";
import type {
  CloneDestination,
  LandingTarget,
} from "@shigomori/ui/views/worktreeDetail/flow/pullSteps.ts";
import type { Project } from "@shigomori/contracts/schemas";
import { cloneIntoOf, moveCloneParent } from "@shared/cloneDestination";
import { useDeviceProjects } from "@/hooks/projects/useProjects";
import { useDestinationScope, useHostScope } from "@/hooks/remote/useHostScope";
import { runtimeInfoQueryOptions } from "@/hooks/system/useRuntimeInfo";
import { ensureTrailingSep, tildify } from "@shigomori/contracts/projectPaths";

// The clone the flow would make, computed only while it is the
// landing (`enabled`): the reads behind it are the destination's home
// and projects and the source's home, none of which a flow into a
// checkout already there needs.
function useCloneDestination(
  sourceProject: Project,
  enabled: boolean,
): CloneDestination {
  // The dialog sits under the source's scope, so its runtime info is
  // the source's home. The destination's comes from its own scope.
  const destination = useDestinationScope();
  const { data: sourceRuntime } = useQuery(
    runtimeInfoQueryOptions(useHostScope(), enabled),
  );
  const { data: destinationRuntime } = useQuery(
    runtimeInfoQueryOptions(destination, enabled),
  );
  const { data: destinationProjects = [] } = useDeviceProjects(
    destination.deviceId,
    enabled && destination.hasHost,
  );
  // A folder picked on one destination means nothing on another.
  const [picked, setPicked] = useState<{
    deviceId: string;
    parent: string;
  } | null>(null);

  const destinationHome = destinationRuntime?.homedir ?? null;
  const parent =
    (picked?.deviceId === destination.deviceId ? picked.parent : null) ??
    (enabled
      ? moveCloneParent({
          sourcePath: sourceProject.path,
          sourceHome: sourceRuntime?.homedir,
          destinationHome,
          destinationProjects,
        })
      : "~/");
  const cloneInto = cloneIntoOf(parent, sourceProject.path);
  return {
    projectName: sourceProject.name,
    cloneInto,
    dest: `${parent}${cloneInto.name}`,
    setParent: (chosen) =>
      setPicked({
        deviceId: destination.deviceId,
        parent: ensureTrailingSep(tildify(chosen, destinationHome)),
      }),
  };
}

// Where a flow lands, decided once: the picked or held project, or
// the clone when the destination holds none. A run reads it off what
// it was submitted with rather than the live project list, since the
// clone registers a project mid-run and a live read would turn the
// running view into a flow that never cloned anything. A flow to a
// peer with no device picked yet has no landing at all.
export function useLandingTarget({
  localProject,
  sourceProject,
  unpicked,
  submitted,
}: {
  localProject: Project | undefined;
  sourceProject: Project;
  unpicked: boolean;
  // The running (or finished) mutation's input, absent on the review.
  submitted: { cloneInto?: SyncCloneInto } | undefined;
}): LandingTarget | null {
  const cloning =
    submitted === undefined
      ? !unpicked && localProject === undefined
      : submitted.cloneInto !== undefined;
  const clone = useCloneDestination(sourceProject, cloning);
  if (cloning) return { clone };
  return localProject === undefined ? null : { project: localProject };
}
