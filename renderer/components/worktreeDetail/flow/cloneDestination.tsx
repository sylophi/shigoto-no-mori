// Where a pull lands when this machine has no checkout of the repo:
// the pulls that land here (a transplant, a mirror) clone it first,
// into a folder the review names and the user can change. The default
// mirrors the source's own layout, the peer's path with its home
// swapped for this one's, so the two machines end up alike without a
// pick; a path outside the peer's home falls back to where this
// device keeps its repos (addProject/cloneDestination.ts). The
// mutation gets the pair as the pull's `cloneInto`.
//
// The landing target is the one fact every piece of a flow reads:
// the project the copy lands in, or the clone that makes one, or
// nothing yet (a flow to a peer with no device picked, which Start
// waits on). Made once per flow (useLandingTarget) and handed down.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderInput, GitBranch } from "lucide-react";
import type { SyncCloneInto } from "@shared/ipc/modules/sync";
import type { Project } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import { defaultCloneParent } from "@/components/addProject/cloneDestination";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { LocalHostScope, useHostScope } from "@/hooks/remote/useHostScope";
import { runtimeInfoQueryOptions } from "@/hooks/system/useRuntimeInfo";
import {
  ensureTrailingSep,
  getBrowseLeafSegment,
  getBrowseParentPath,
  normalizeForSubmit,
  tildify,
} from "@/lib/projectPaths";
import { CARD } from "./FlowChrome";

export type CloneDestination = {
  // The project on the peer, for the name and the words.
  projectName: string;
  // The pair the pull takes, the parent tildified as the picker
  // reports it (the host expands `~`).
  cloneInto: SyncCloneInto;
  // The whole path, for display.
  dest: string;
  setParent: (chosen: string) => void;
};

export type LandingTarget =
  | { project: Project; clone?: undefined }
  | { project?: undefined; clone: CloneDestination };

// The clone the flow would make, computed only while it is the
// landing (`enabled`): the reads behind it are this machine's home
// and projects and the peer's home, none of which a flow into a
// checkout already here needs.
function useCloneDestination(
  sourceProject: Project,
  enabled: boolean,
): CloneDestination {
  // The dialog sits under the source's scope, so its runtime info is
  // the peer's home. This machine's comes from the local scope.
  const { data: peerRuntime } = useQuery({
    ...runtimeInfoQueryOptions(useHostScope()),
    enabled,
  });
  const { data: localRuntime } = useQuery({
    ...runtimeInfoQueryOptions({}),
    enabled,
  });
  const { data: localProjects = [] } = useQuery({
    ...projectsQueryOptions({}),
    enabled,
  });
  const [picked, setPicked] = useState<string | null>(null);

  const localHome = localRuntime?.homedir ?? null;
  const name = getBrowseLeafSegment(sourceProject.path);
  const peerParent = getBrowseParentPath(sourceProject.path);
  const alike =
    peerParent === null ? null : tildify(peerParent, peerRuntime?.homedir);
  const parent =
    picked ??
    (alike?.startsWith("~") ? alike : null) ??
    (enabled ? defaultCloneParent(localProjects, localHome) : "~/");
  return {
    projectName: sourceProject.name,
    cloneInto: { parentDir: normalizeForSubmit(parent), name },
    dest: `${parent}${name}`,
    setParent: (chosen) =>
      setPicked(ensureTrailingSep(tildify(chosen, localHome))),
  };
}

// Where a flow lands, decided once: the picked or held project, or
// the clone when this machine holds none. A run reads it off what it
// was submitted with rather than the live project list, since the
// clone registers a project mid-run and a live read would turn the
// running view into a flow that never cloned anything. A flow to a
// peer never clones: the peer must hold the repo.
export function useLandingTarget({
  localProject,
  sourceProject,
  toPeer,
  submitted,
}: {
  localProject: Project | undefined;
  sourceProject: Project;
  toPeer: boolean;
  // The running (or finished) mutation's input, absent on the review.
  submitted: { cloneInto?: SyncCloneInto } | undefined;
}): LandingTarget | null {
  const cloning =
    !toPeer &&
    (submitted === undefined
      ? localProject === undefined
      : submitted.cloneInto !== undefined);
  const clone = useCloneDestination(sourceProject, cloning);
  if (cloning) return { clone };
  return localProject === undefined ? null : { project: localProject };
}

// The review's clone section, in place of the folder and setup cards
// a landing project would get: the repo, where its checkout lands,
// and the way to change that. The picker browses this machine.
export function CloneDestinationSection({
  clone,
  thisDeviceLabel,
}: {
  clone: CloneDestination;
  thisDeviceLabel: string;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <section className="space-y-2">
      <SectionHeading>Clone on {thisDeviceLabel}</SectionHeading>
      <div className={`${CARD} flex flex-col gap-2 text-xs`}>
        <div className="flex items-center gap-2">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground/80" />
          <span className="min-w-0 flex-1 truncate font-mono">
            {clone.projectName}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <FolderInput className="size-3.5 shrink-0 text-muted-foreground/80" />
          <PathSpan
            path={clone.dest}
            home={null}
            className="min-w-0 flex-1 truncate font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setPicking(true)}
          >
            Change folder
          </Button>
        </div>
        <p className="text-muted-foreground">
          {thisDeviceLabel} has no checkout of this repo yet. It is cloned from
          the other device first, added as a project, and the copy lands beside
          it.
        </p>
      </div>
      {picking && (
        <LocalHostScope>
          <FolderPickerModal
            initialPath={clone.cloneInto.parentDir}
            title="Clone into"
            hint={`${clone.projectName} becomes a new folder inside the one you pick.`}
            onPick={(chosen) => {
              clone.setParent(chosen);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />
        </LocalHostScope>
      )}
    </section>
  );
}
