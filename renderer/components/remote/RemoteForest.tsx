import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  FolderGit2,
  Loader2,
  Plus,
  Settings as SettingsIcon,
  Shovel,
} from "lucide-react";
import { useState } from "react";
import { errorMessageOf } from "@shared/errors";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import type {
  SyncPullWorktreeResult,
  SyncTransplantWorktreeResult,
} from "@shared/ipc/modules/sync";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { BranchLabel } from "@/components/ui/branch-label";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveButton } from "@/components/ui/confirm-destructive-button";
import { Input } from "@/components/ui/input";
import { MergedPrimaryBranchBox } from "@/components/worktreeDetail/pullRequests/MergedPrimaryBranchBox";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { PageHeader } from "@/components/shared/PageHeader";
import { DeviceStatusDot } from "./DeviceStatusDot";
import { EmptyPanel } from "./EmptyPanel";
import { PortForwardSection } from "./PortForwardSection";
import { RemoteDeviceSettings } from "./RemoteDeviceSettings";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { HostScopeProvider, useHostScope } from "@/hooks/remote/useHostScope";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import {
  useCreateWorktree,
  useDeleteWorktree,
} from "@/hooks/worktrees/useWorktreeMutations";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import {
  useAllRemoteWorktrees,
  useRemoteProjects,
} from "@/hooks/remote/useRemoteForest";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useWatchRemoteHost } from "@/hooks/remote/useWatchRemoteHost";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { deviceVersionMismatch } from "@/lib/remote/devices";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError, toast } from "@/lib/toast";

const route = getRouteApi("/devices/$deviceId");

// Another machine's forest (v2 step 3, slice C; mutations in step 6,
// slice C). Reads are always available. Write controls (create, delete,
// land) render only when this device holds command access on the host,
// resolved per-caller by useCommandAccess. When the host has NOT granted
// this device, the page stays read-only and shows an inline note instead:
// granting is host-side (the target's Settings > Account) and there is no
// request-over-wire mechanism here. Every control acts through the
// scope-clean mutation hooks (targeting this device via HostScopeProvider)
// and relies on their device-scoped key invalidation to refresh the forest
// in place — no navigation to a local /projects route, which wouldn't
// exist for a remote device or in the web shell.
export function RemoteForest() {
  const { deviceId } = route.useParams();
  const devices = useRemoteDevices();
  // The registry holds both LAN and relay entries, and a stale LAN entry
  // (api undefined, in backoff) can share a deviceId with a live relay
  // entry for the same machine. Prefer a SERVING entry so that stale twin
  // does not shadow the live one and strand this page (I2). Guard the
  // empty id explicitly: an unconnected entry also carries "", so
  // matching on it would pick an arbitrary disconnected device.
  const device =
    deviceId === ""
      ? undefined
      : (devices.find((d) => d.deviceId === deviceId && d.api !== undefined) ??
        devices.find((d) => d.deviceId === deviceId));

  if (device === undefined) {
    return (
      <ForestShell title="Remote forest">
        <EmptyPanel>
          This device isn&apos;t connected. Open Settings to add or reconnect
          it, then try again.
        </EmptyPanel>
      </ForestShell>
    );
  }

  return <ConnectedForest device={device} deviceId={deviceId} />;
}

function ConnectedForest({
  device,
  deviceId,
}: {
  device: ReturnType<typeof useRemoteDevices>[number];
  deviceId: string;
}) {
  const api = device.api;
  // Push-driven refresh: while connected, the host's externalChange and
  // refsRefreshed broadcasts invalidate this device's cached queries in
  // place, instead of waiting out staleTime or a window focus.
  useWatchRemoteHost(device);
  // Forest or settings body, toggled by the header gear (v2 step 6).
  // Plain component state on the SAME route: the settings body is a
  // view of this page, not a place, so the web shell needs no new
  // route and closing it never navigates.
  const [showSettings, setShowSettings] = useState(false);
  const {
    data: projects = [],
    isPending,
    isError,
    error,
  } = useRemoteProjects(deviceId, api);
  const worktreeQueries = useAllRemoteWorktrees(deviceId, api, projects);
  const worktreesByProject = new Map<string, Worktree[]>(
    projects.map((project, index) => [
      project.id,
      worktreeQueries[index]?.data ?? [],
    ]),
  );

  const { connected } = deviceStatusView(device.status);
  const mismatch = deviceVersionMismatch(device);
  // Settings needs a live connection to read and write; fall back to
  // the forest's status panels whenever the link lapses so the toggle
  // can't strand a dead editor.
  const settingsOpen = showSettings && connected && api !== undefined;

  const shell = (
    <ForestShell
      title={device.label}
      status={<DeviceStatusDot status={device.status} />}
      actions={
        connected &&
        api !== undefined && (
          <DeviceSettingsToggle
            open={settingsOpen}
            onToggle={() => setShowSettings((prev) => !prev)}
          />
        )
      }
      full={settingsOpen}
    >
      {settingsOpen ? (
        <RemoteDeviceSettings />
      ) : (
        <>
          {mismatch && (
            <p className="text-xs text-amber-500">
              This device is running a different app version. Update the other
              machine if something looks off.
            </p>
          )}

          {!connected ? (
            <EmptyPanel>
              {device.status.phase === "blocked"
                ? `Can't connect: ${device.status.message}.`
                : // The honest phase label, not a blanket "Connecting" that
                  // lies for a stopped or backing-off device (I4).
                  deviceStatusView(device.status).label}
            </EmptyPanel>
          ) : isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : isError ? (
            // remoteProjectsQueryOptions sets silentError expecting the
            // forest to render its own inline error, so a failed query shows
            // the reason rather than a misleading empty "No projects" (I4).
            <EmptyPanel>
              Couldn&apos;t load this device&apos;s forest:{" "}
              {errorMessageOf(error)}
            </EmptyPanel>
          ) : projects.length === 0 ? (
            <EmptyPanel>No projects on this device yet.</EmptyPanel>
          ) : (
            // A loaded forest always has an api (the listing queries route
            // through it); the guard narrows it for the provider branch below.
            api && (
              <ForestBody
                projects={projects}
                worktreesByProject={worktreesByProject}
              />
            )
          )}
          {/* App-only (the engine binds real local listeners, which the
              web shell cannot), so the web build never mounts it. */}
          {connected && api !== undefined && window.api.isElectron && (
            <PortForwardSection />
          )}
        </>
      )}
    </ForestShell>
  );

  // One provider around the whole shell (rather than around ForestBody
  // alone) so the header's grant-gated gear and the settings body share
  // the same scope as the forest's mutation controls.
  return api === undefined ? (
    shell
  ) : (
    <HostScopeProvider deviceId={deviceId} api={api}>
      {shell}
    </HostScopeProvider>
  );
}

// The header gear: opens the device's settings, so it only exists when
// this device holds command access on the host (the settings body is a
// write surface; a read-only visitor gets no dangling entry point).
// While OPEN it stays rendered even if the verdict flips to refused
// mid-session, so the user can always toggle back to the forest.
function DeviceSettingsToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const { granted } = useCommandAccess();
  if (!granted && !open) return null;
  return (
    <Button
      type="button"
      size="icon-xs"
      variant={open ? "secondary" : "ghost"}
      aria-label={open ? "Back to forest" : "Device settings"}
      aria-pressed={open}
      onClick={onToggle}
    >
      <SettingsIcon />
    </Button>
  );
}

// Under the host-scope provider: gate the write affordances on this
// device's command-access verdict, and hang the projects off it.
function ForestBody({
  projects,
  worktreesByProject,
}: {
  projects: Project[];
  worktreesByProject: Map<string, Worktree[]>;
}) {
  const { granted, isLoading } = useCommandAccess();
  // The LOCAL device's projects (explicitly scope-less despite the
  // surrounding provider), for the pull-here gate: a remote worktree is
  // pullable only into a local project sharing the repo's identity. On
  // the web the local list stubs to [], so the control structurally
  // never renders there.
  const { data: localProjects = [] } = useQuery(projectsQueryOptions({}));
  return (
    <div className="flex flex-col gap-4">
      {!granted && !isLoading && (
        <p className="text-xs text-muted-foreground">
          You have read-only access to this device. Command access is granted
          from its Settings &gt; Account.
        </p>
      )}
      {projects.map((project) => (
        <RemoteProjectGroup
          key={project.id}
          project={project}
          worktrees={worktreesByProject.get(project.id) ?? []}
          granted={granted}
          localProject={
            project.identity != null
              ? localProjects.find(
                  (local) =>
                    local.identity != null &&
                    local.identity === project.identity,
                )
              : undefined
          }
        />
      ))}
    </div>
  );
}

function RemoteProjectGroup({
  project,
  worktrees,
  granted,
  localProject,
}: {
  project: Project;
  worktrees: Worktree[];
  granted: boolean;
  // The first local project with the same repo identity, if any.
  localProject: Project | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <FolderGit2 className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{project.name}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">
          {worktrees.length}
        </span>
        {granted && (
          <div className="ml-auto shrink-0">
            <CreateWorktreeControl projectId={project.id} />
          </div>
        )}
      </div>
      {worktrees.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground/70">No worktrees.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {worktrees.map((worktree) => (
            <RemoteWorktreeRow
              key={worktree.id}
              worktree={worktree}
              granted={granted}
              project={project}
              localProject={localProject}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Display-only row plus, when granted, a lifecycle control: delete for a
// regular worktree, land (switch the root back to primary and drop the
// merged branch) for the primary checkout. The local WorktreeRow
// navigates to local routes and reads local PR state, so this reuses only
// the pure display primitives (BranchLabel, WorktreeKindIcon) and adds
// nav-free scoped mutations of its own.
function RemoteWorktreeRow({
  worktree,
  granted,
  project,
  localProject,
}: {
  worktree: Worktree;
  granted: boolean;
  project: Project;
  localProject: Project | undefined;
}) {
  // Pull-here gate: command access, a real (non-detached) branch the
  // bundle allowlist can carry, and a local identity match. Primary
  // rows keep their land control instead -- pulling the primary makes
  // no sense here.
  const pullTarget =
    localProject !== undefined &&
    project.identity != null &&
    isRealBranch(worktree.branch) &&
    !worktree.detached
      ? { sourceIdentity: project.identity, localProjectId: localProject.id }
      : undefined;
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono">
          <BranchLabel branch={worktree.branch} detached={worktree.detached} />
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {worktree.name}
        </span>
      </div>
      {(worktree.ahead > 0 || worktree.behind > 0) && (
        <span className="tabular shrink-0 text-[10px] text-muted-foreground/70">
          {worktree.ahead > 0 && `↑${worktree.ahead}`}
          {worktree.ahead > 0 && worktree.behind > 0 && " "}
          {worktree.behind > 0 && `↓${worktree.behind}`}
        </span>
      )}
      <WorktreeKindIcon worktree={worktree} />
      {granted &&
        (worktree.isPrimary ? (
          // Self-gates: renders nothing unless the root sits on a merged,
          // non-primary branch. The only forest-level land the app has
          // that is free of PR-merge and navigation.
          <MergedPrimaryBranchBox worktree={worktree} />
        ) : (
          <>
            {pullTarget && (
              <>
                <BringHereControl
                  transplant={false}
                  worktree={worktree}
                  sourceProjectId={project.id}
                  sourceIdentity={pullTarget.sourceIdentity}
                  localProjectId={pullTarget.localProjectId}
                />
                <BringHereControl
                  transplant
                  worktree={worktree}
                  sourceProjectId={project.id}
                  sourceIdentity={pullTarget.sourceIdentity}
                  localProjectId={pullTarget.localProjectId}
                />
              </>
            )}
            <DeleteWorktreeControl worktree={worktree} />
          </>
        ))}
    </div>
  );
}

// The one bring-a-peer's-worktree-here mutation behind both controls
// below (pull: v2 step 7 slice C, transplant: step 9): capture,
// transfer, create, and dirty apply ride a single pending state --
// create-phase progress streams to the local worktree's own detail
// page, not this forest. The handler re-verifies the identity match;
// the gate in the controls is UX, not the wall. Refusals surface
// centrally, everything else toasts here. The result lands on another
// page (the local forest), so the toast is the only visible conclusion.
function useBringWorktreeHere({
  worktree,
  sourceProjectId,
  sourceIdentity,
  localProjectId,
  transplant,
}: {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
  transplant: boolean;
}) {
  const { deviceId } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    // The explicit union return type keeps the transplant-only fields
    // narrowable via "sourceRemoved" in result below.
    mutationFn: (): Promise<
      SyncPullWorktreeResult | SyncTransplantWorktreeResult
    > => {
      const payload = {
        sourceDeviceId: deviceId,
        sourceProjectId,
        sourceWorktreeId: worktree.id,
        sourceIdentity,
        branch: worktree.branch,
      };
      return transplant
        ? window.api.sync.transplantWorktree(payload)
        : window.api.sync.pullWorktree(payload);
    },
    onSuccess: (result) => {
      // The new worktree and branch are LOCAL, so this invalidates the
      // local device's registry (module-level queryKeys), never the
      // surrounding remote scope's. On a transplant the source side
      // refreshes off the host's own resolved-mutation ping
      // (useWatchRemoteHost).
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(localProjectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.branches(localProjectId),
      });
      if ("sourceRemoved" in result) {
        // Transplant: a refused or failed teardown (including a dirty
        // state that did not land here) is a partial success the
        // handler reports via sourceRemoved/sourceError instead of
        // throwing, so it lands in onSuccess with its own voice.
        if (result.sourceRemoved) {
          toast.success(`Transplanted ${worktree.branch} here`);
        } else {
          notifyError(
            `Brought ${worktree.branch} here, but the source worktree stayed`,
            result.sourceError !== undefined &&
              result.sourceError.includes("scripts-running")
              ? "Scripts are still running there."
              : result.sourceError,
          );
        }
        return;
      }
      // Pull: an unapplied capture is a partial success, the worktree
      // is real and the uncommitted changes stayed safe on the source.
      if (result.dirtyApplied || !result.captured) {
        toast.success(`Brought ${worktree.branch} here`);
      } else {
        notifyError(
          `Brought ${worktree.branch} here, without its uncommitted changes`,
          "They could not be applied and are still on the other device.",
        );
      }
    },
    onError: (err) => {
      if (!isCommandRefusedError(err)) {
        notifyError(
          transplant
            ? "Couldn't transplant worktree"
            : "Couldn't bring worktree here",
          err,
        );
      }
    },
    meta: { silentError: true },
  });
}

// Pull and transplant share the mutation above and this one icon
// button; they differ only in icon, label, and that a transplant is
// destructive on the remote side, so it two-step confirms like the
// delete control. The armed state rides the ghost-destructive variant
// (aria-pressed and the swapped aria-label carry it for screen
// readers) to keep the row's compact icon look.
function BringHereControl({
  transplant,
  ...props
}: {
  transplant: boolean;
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
}) {
  const bring = useBringWorktreeHere({ ...props, transplant });
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  return (
    <Button
      type="button"
      size="icon-xs"
      variant={transplant && armed ? "ghost-destructive" : "ghost"}
      aria-label={
        transplant
          ? armed
            ? "Click again to confirm transplant"
            : "Transplant this worktree here"
          : "Bring this worktree here"
      }
      aria-pressed={transplant ? armed : undefined}
      disabled={bring.isPending}
      onClick={() =>
        transplant ? trigger(() => bring.mutate()) : bring.mutate()
      }
    >
      {bring.isPending ? (
        <Loader2 className="animate-spin" />
      ) : transplant ? (
        <Shovel />
      ) : (
        <ArrowDownToLine />
      )}
    </Button>
  );
}

// Two-step confirm delete through the raw scoped mutation (no navigation:
// the forest refetches off the mutation's device-scoped invalidation). A
// non-refusal failure (a dirty or locked worktree that would need force)
// toasts here rather than looking like a no-op. Refusals surface centrally.
function DeleteWorktreeControl({ worktree }: { worktree: Worktree }) {
  const del = useDeleteWorktree();
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  const run = () =>
    del.mutate(
      { projectId: worktree.projectId, worktreeId: worktree.id },
      {
        onError: (err) => {
          if (!isCommandRefusedError(err)) {
            notifyError("Couldn't delete worktree", err);
          }
        },
      },
    );
  return (
    <ConfirmDestructiveButton
      armed={armed}
      pending={del.isPending}
      pendingLabel="Deleting…"
      idleLabel="Delete"
      onClick={() => trigger(run)}
    />
  );
}

// Minimal inline create off the project's default branch (optional name).
// Uses the raw create mutation, not the quick-create helper, which
// navigates to a local /projects route the remote forest can't reach.
// The open form is a separate component so the default-branch fetch only
// runs once the user opens it, not for every collapsed button.
function CreateWorktreeControl({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="New worktree"
        onClick={() => setOpen(true)}
      >
        <Plus />
      </Button>
    );
  }

  return (
    <CreateWorktreeForm projectId={projectId} onClose={() => setOpen(false)} />
  );
}

function CreateWorktreeForm({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const create = useCreateWorktree();
  const { data: defaultBranch } = useDefaultBranch(projectId);

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          {
            projectId,
            worktreeName: name.trim() || undefined,
            base: defaultBranch,
          },
          { onSuccess: onClose },
        );
      }}
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name (optional)"
        aria-label="New worktree name"
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- inline create just opened
        autoFocus
        className="h-6 w-40 px-2 text-xs"
      />
      <Button
        type="submit"
        size="xs"
        variant="secondary"
        // Wait for the default branch so create always has a base, exactly
        // as quick-create resolves one before firing.
        disabled={create.isPending || defaultBranch === undefined}
      >
        {create.isPending ? <Loader2 className="animate-spin" /> : "Create"}
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
    </form>
  );
}

function ForestShell({
  title,
  status,
  actions,
  full = false,
  children,
}: {
  title: string;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  // Default: children flow in the shell's scrollable column. `full`
  // hands the whole below-header area to the children instead, for a
  // body that brings its own scroll region and pinned footer (the
  // settings editor).
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Remote device"
        title={title}
        watermark="端末"
        status={status}
        actions={actions}
      />
      {full ? (
        children
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="flex max-w-3xl flex-col gap-6">{children}</div>
        </div>
      )}
    </div>
  );
}
