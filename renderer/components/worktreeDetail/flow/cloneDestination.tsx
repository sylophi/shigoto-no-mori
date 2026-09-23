// Where the repo goes when this machine has no checkout of it: the
// pulls that land here (a transplant, a mirror) clone it first, into
// a folder the review names and the user can change. The default
// mirrors the source's own layout, the peer's path with its home
// swapped for this one's, so the two machines end up alike without a
// pick; a path outside the peer's home falls back to where this
// device keeps its repos (addProject/cloneDestination.ts). The
// mutation gets the pair as the pull's `cloneInto`.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderInput, GitBranch } from "lucide-react";
import type { SyncCloneInto } from "@shared/ipc/modules/sync";
import type { Project, RuntimeInfo } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import { defaultCloneParent } from "@/components/addProject/cloneDestination";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { LocalHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { ensureTrailingSep, tildify } from "@/lib/projectPaths";
import { queryKeys } from "@/lib/queryKeys";
import { CARD } from "./FlowChrome";

export type CloneDestination = {
  // The project on the peer, for the name and the words.
  projectName: string;
  // The pair the pull takes, the parent tildified as the picker
  // reports it (the host expands `~`).
  cloneInto: SyncCloneInto;
  // The whole path, for display.
  dest: string;
  changeParent: () => void;
  // The picker, mounted by the section while it is up.
  picker: { open: boolean; close: () => void; pick: (parent: string) => void };
};

// This machine's home, whichever scope the caller sits under: the
// dialog is under the source's, and the peer's home is what
// useRuntimeInfo answers there.
function useLocalHome(): string | null {
  const { data } = useQuery<RuntimeInfo>({
    queryKey: queryKeys.runtimeInfo(),
    queryFn: () => window.api.runtime.info(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data?.homedir ?? null;
}

export function useCloneDestination(sourceProject: Project): CloneDestination {
  const { data: peerRuntime } = useRuntimeInfo();
  const localHome = useLocalHome();
  const { data: localProjects = [] } = useQuery(projectsQueryOptions({}));
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const path = sourceProject.path;
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  const peerHome = peerRuntime?.homedir;
  const peerParent = slash > 0 ? path.slice(0, slash) : null;
  const alike =
    peerHome !== undefined &&
    peerParent !== null &&
    (peerParent === peerHome || peerParent.startsWith(`${peerHome}/`))
      ? ensureTrailingSep(tildify(peerParent, peerHome))
      : null;
  const parent =
    picked ?? alike ?? defaultCloneParent(localProjects, localHome);
  return {
    projectName: sourceProject.name,
    cloneInto: { parentDir: parent.replace(/\/+$/, "") || "/", name },
    dest: `${parent}${name}`,
    changeParent: () => setOpen(true),
    picker: {
      open,
      close: () => setOpen(false),
      pick: (chosen) => {
        setPicked(ensureTrailingSep(tildify(chosen, localHome)));
        setOpen(false);
      },
    },
  };
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
            onClick={clone.changeParent}
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
      {clone.picker.open && (
        <LocalHostScope>
          <FolderPickerModal
            initialPath={clone.cloneInto.parentDir}
            title="Clone into"
            hint={`${clone.projectName} becomes a new folder inside the one you pick.`}
            onPick={clone.picker.pick}
            onClose={clone.picker.close}
          />
        </LocalHostScope>
      )}
    </section>
  );
}
