// A worktree row's right-click (WorktreeMenuView), in the tree and the
// inbox alike. What its page's footer holds acts on the device the
// worktree lives on, so it needs that device to take commands from
// here.
import type { ReactElement } from "react";
import { isCommandRefusedError } from "@shigomori/contracts/errors";
import {
  canSetAutoPull,
  isManagedWorktree,
  type Project,
  type PullRequest,
  type Worktree,
} from "@shigomori/contracts/schemas";
import {
  WorktreeMenuLeadView,
  WorktreeMenuManageView,
  WorktreeMenuTransfersView,
  WorktreeMenuView,
} from "@shigomori/ui/views/sidebar/WorktreeMenuView.tsx";
import {
  transferSource,
  usePeerTransferOffers,
  type TransferOffers,
} from "@/components/worktreeDetail/PeerTransferActions";
import { useRemoteTransferOffers } from "@/components/worktreeDetail/RemoteWorktreeActions";
import { useProjects } from "@/hooks/projects/useProjects";
import { useCommandableDeviceApi } from "@/hooks/remote/useCommandAccess";
import { MaybeHostScope, useHostScope } from "@/hooks/remote/useHostScope";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { useDeleteBlockedReason } from "@/hooks/worktrees/useDeleteAndNavigate";
import {
  useDeleteWorktree,
  useIsDeletingWorktree,
  useSetAutoPull,
  useSetShelved,
} from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { WorktreeDialog } from "@/lib/routePaths";
import { notifyError } from "@/lib/toast";
import { useGoToProject } from "./openProject";

type DeleteArm = ReturnType<typeof useConfirmTwice>;

interface WorktreeMenuProps {
  worktree: Worktree;
  pr: PullRequest | undefined;
  // The peer the worktree lives on, absent for this machine's own.
  deviceId: string | undefined;
  // The inbox's: the menu leads with the way to it in the tree. The
  // tree's rows sit under their project already.
  project?: Project;
}

export function WorktreeMenu({
  row,
  ...props
}: WorktreeMenuProps & { row: ReactElement }) {
  // Held by the root and cleared the moment the menu closes, as the
  // project menu's remove is (useProjectMenuRemoveArm): the list
  // unmounts only after its exit animation, and a reopen inside it
  // would find the item still armed.
  const deleteArm = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  return (
    <WorktreeMenuView
      row={row}
      onOpenChange={(open) => {
        if (!open) deleteArm.reset();
      }}
    >
      <MenuItems {...props} deleteArm={deleteArm} />
    </WorktreeMenuView>
  );
}

function MenuItems({
  worktree,
  pr,
  deviceId,
  project,
  deleteArm,
}: WorktreeMenuProps & { deleteArm: DeleteArm }) {
  const peerApi = useCommandableDeviceApi(deviceId);
  const commandable = deviceId === undefined || peerApi !== undefined;
  const goToProject = useGoToProject();
  return (
    <>
      <WorktreeMenuLeadView
        onGoToProject={project && (() => goToProject(project, deviceId))}
        pullRequest={pr}
        path={worktree.path}
        branch={worktree.detached ? undefined : worktree.branch}
      />
      {commandable && (
        <MaybeHostScope deviceId={deviceId ?? ""} api={peerApi}>
          <TransferItems worktree={worktree} />
          <ManageItems worktree={worktree} deleteArm={deleteArm} />
        </MaybeHostScope>
      )}
    </>
  );
}

// Their dialogs belong to the page, so a pick opens the page with its
// dialog up (useTakeWorktreeDialog).
function TransferItems({ worktree }: { worktree: Worktree }) {
  const { remote } = useHostScope();
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === worktree.projectId);
  if (project === undefined || transferSource(worktree, project) === null) {
    return null;
  }
  return remote ? (
    <RemoteTransferItems worktree={worktree} />
  ) : (
    <LocalTransferItems worktree={worktree} project={project} />
  );
}

function LocalTransferItems({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  const offers = usePeerTransferOffers(worktree, project);
  return <TransferMenuItems worktree={worktree} offers={offers} />;
}

function RemoteTransferItems({ worktree }: { worktree: Worktree }) {
  const offers = useRemoteTransferOffers(worktree);
  return <TransferMenuItems worktree={worktree} offers={offers} />;
}

function TransferMenuItems({
  worktree,
  offers,
}: {
  worktree: Worktree;
  offers: TransferOffers;
}) {
  const nav = useWorktreeNav();
  const open = (dialog: WorktreeDialog) => () =>
    nav.toWorktreeDialog(worktree.projectId, worktree.id, dialog);
  return (
    <WorktreeMenuTransfersView
      onMirroring={offers.mirroring ? open("mirroring") : undefined}
      mirror={
        offers.mirror
          ? {
              disabled: offers.mirrorBlocker !== undefined,
              onClick: open("mirror"),
            }
          : undefined
      }
      onTransplant={offers.transplant ? open("transplant") : undefined}
    />
  );
}

// The delete is the footer's without its page: a refusal (uncommitted
// changes) or a cleanup that kept the worktree says so in a toast, and
// the page's delete takes it from there with its force and its
// cleanup's output. Gone, the worktree's open page leaves on its own
// (WorktreeDetail).
function ManageItems({
  worktree,
  deleteArm,
}: {
  worktree: Worktree;
  deleteArm: DeleteArm;
}) {
  const setAutoPull = useSetAutoPull();
  const setShelved = useSetShelved();
  const deleteWorktree = useDeleteWorktree();
  const deleting = useIsDeletingWorktree(worktree.id);
  const deleteBlocked = useDeleteBlockedReason(worktree) !== undefined;
  const target = { projectId: worktree.projectId, worktreeId: worktree.id };

  // Answered off the promise: the list unmounts as the menu closes,
  // which drops callbacks given to mutate.
  const runDelete = () =>
    deleteWorktree.mutateAsync(target).then(
      (data) => {
        if (data.ok) return;
        const { phase, exitCode } = data.cleanupError;
        notifyError(
          "Kept the worktree: its cleanup didn't complete cleanly",
          `${phase === "teardown" ? "Teardown" : "Port-pool release"} exited with ${exitCode ?? "an error"}.`,
        );
      },
      (error: unknown) => {
        // A peer's refusal is toasted centrally.
        if (!isCommandRefusedError(error)) {
          notifyError("Couldn't delete the worktree", error);
        }
      },
    );

  return (
    <WorktreeMenuManageView
      autoPull={{
        checked: worktree.autoPull,
        disabled:
          !canSetAutoPull(worktree) || deleting || setAutoPull.isPending,
        onChange: (autoPull) => setAutoPull.mutate({ ...target, autoPull }),
      }}
      // The primary checkout is the project itself: never shelved,
      // never deleted. One made by hand elsewhere can go, but has no
      // shelf.
      shelve={
        isManagedWorktree(worktree)
          ? {
              shelved: worktree.shelved,
              disabled: deleting || setShelved.isPending,
              onToggle: () =>
                setShelved.mutate({ ...target, shelved: !worktree.shelved }),
            }
          : undefined
      }
      remove={
        worktree.isPrimary
          ? undefined
          : {
              armed: deleteArm.armed,
              disabled: deleting || deleteBlocked,
              onClick: () => deleteArm.trigger(() => void runDelete()),
            }
      }
    />
  );
}
