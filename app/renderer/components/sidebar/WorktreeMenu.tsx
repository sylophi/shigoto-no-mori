import type { ReactElement } from "react";
import {
  Archive,
  ArchiveRestore,
  Copy,
  GitPullRequest,
  ListTree,
  RefreshCw,
  Shovel,
  Trash2,
} from "lucide-react";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import {
  canSetAutoPull,
  isManagedWorktree,
  type Project,
  type PullRequest,
  type Worktree,
} from "@shared/schemas";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuArmedLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  transferSource,
  usePeerTransferOffers,
  type TransferOffers,
} from "@/components/worktreeDetail/PeerTransferActions";
import { openPullRequest } from "@/components/worktreeDetail/pullRequests/pullRequestShared";
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

// A worktree row's right-click, in the tree and the inbox alike: the
// ways off it (its project, from the inbox, and its PR), its path and
// branch to copy, then what its page's footer holds (mirror,
// transplant, auto-pull, the shelf and delete). Those act on the
// device the worktree lives on, so they need that device to take
// commands from here. The list mounts only while the menu is open, so
// a row carries no more than the root.
export function WorktreeMenu({
  row,
  ...props
}: WorktreeMenuProps & {
  // An element for the trigger to `render`, so it wraps no extra div.
  row: ReactElement;
}) {
  // Held by the root and cleared the moment the menu closes, as the
  // project menu's remove is (useProjectMenuRemoveArm): the list
  // unmounts only after its exit animation, and a reopen inside it
  // would find the item still armed.
  const deleteArm = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) deleteArm.reset();
      }}
    >
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        <MenuItems {...props} deleteArm={deleteArm} />
      </ContextMenuContent>
    </ContextMenu>
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
  return (
    <>
      {project && <GoToProjectItem project={project} deviceId={deviceId} />}
      {pr && (
        <DropdownMenuItem onClick={() => openPullRequest(pr.url)}>
          <GitPullRequest />
          Open pull request #{pr.number}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={() => void navigator.clipboard.writeText(worktree.path)}
      >
        <Copy />
        Copy path
      </DropdownMenuItem>
      {!worktree.detached && (
        <DropdownMenuItem
          onClick={() => void navigator.clipboard.writeText(worktree.branch)}
        >
          <Copy />
          Copy branch name
        </DropdownMenuItem>
      )}
      {commandable && (
        <MaybeHostScope deviceId={deviceId ?? ""} api={peerApi}>
          <TransferItems worktree={worktree} />
          <ManageItems worktree={worktree} deleteArm={deleteArm} />
        </MaybeHostScope>
      )}
    </>
  );
}

function GoToProjectItem({
  project,
  deviceId,
}: {
  project: Project;
  deviceId: string | undefined;
}) {
  const goToProject = useGoToProject();
  return (
    <DropdownMenuItem onClick={() => goToProject(project, deviceId)}>
      <ListTree />
      Go to project
    </DropdownMenuItem>
  );
}

// Mirror and transplant, when the page's footer would offer them. Their
// dialogs belong to the page, so a pick opens the page with its dialog
// up (useTakeWorktreeDialog). A worktree already mirrored offers its
// running mirror instead, as the footer's Mirroring button does.
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
  if (!offers.mirroring && !offers.mirror && !offers.transplant) return null;
  const open = (dialog: WorktreeDialog) =>
    nav.toWorktreeDialog(worktree.projectId, worktree.id, dialog);
  return (
    <>
      <DropdownMenuSeparator />
      {offers.mirroring && (
        <DropdownMenuItem onClick={() => open("mirroring")}>
          <RefreshCw />
          Mirroring…
        </DropdownMenuItem>
      )}
      {offers.mirror && (
        <DropdownMenuItem
          disabled={offers.mirrorBlocker !== undefined}
          onClick={() => open("mirror")}
        >
          <RefreshCw />
          Mirror…
        </DropdownMenuItem>
      )}
      {offers.transplant && (
        <DropdownMenuItem onClick={() => open("transplant")}>
          <Shovel />
          Transplant…
        </DropdownMenuItem>
      )}
    </>
  );
}

// Auto-pull, the shelf and delete. The delete is the footer's without
// its page: a refusal (uncommitted changes) or a cleanup that kept the
// worktree says so in a toast, and the page's delete takes it from
// there with its force and its cleanup's output. Gone, the worktree's
// open page leaves on its own (WorktreeDetail).
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
    <>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={worktree.autoPull}
        disabled={
          !canSetAutoPull(worktree) || deleting || setAutoPull.isPending
        }
        onCheckedChange={(autoPull) =>
          setAutoPull.mutate({ ...target, autoPull })
        }
      >
        <RefreshCw />
        Auto-pull
      </DropdownMenuCheckboxItem>
      {/* The primary checkout is the project itself: never shelved,
          never deleted. One made by hand elsewhere can go, but has no
          shelf. */}
      {isManagedWorktree(worktree) && (
        <DropdownMenuItem
          disabled={deleting || setShelved.isPending}
          onClick={() =>
            setShelved.mutate({ ...target, shelved: !worktree.shelved })
          }
        >
          {worktree.shelved ? <ArchiveRestore /> : <Archive />}
          {worktree.shelved ? "Unshelve" : "Shelve"}
        </DropdownMenuItem>
      )}
      {!worktree.isPrimary && (
        <DropdownMenuItem
          variant="destructive"
          disabled={deleting || deleteBlocked}
          closeOnClick={deleteArm.armed}
          onClick={(event) => {
            if (!deleteArm.armed) event.preventDefault();
            deleteArm.trigger(() => void runDelete());
          }}
        >
          <Trash2 />
          <DropdownMenuArmedLabel
            armed={deleteArm.armed}
            label="Delete worktree"
            armedLabel="Click again to delete"
          />
        </DropdownMenuItem>
      )}
    </>
  );
}
