import { type ReactNode, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shigomori/contracts/schemas";
import type { RowStatus } from "@/components/ui/row-status";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import {
  DeviceTabPanel,
  pickHostDevice,
  useDeviceTabs,
  useHostDevicePick,
  type DeviceTab,
} from "@/components/shared/DeviceTabs";
import { DeviceTabBarView } from "@/components/shared/DeviceTabBarView";
import { localDeviceId } from "@/lib/queryKeys";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import {
  useAllProjectHygiene,
  useWorktreeDiskUsage,
} from "@/hooks/hygiene/useWorktreeHygiene";
import { useProjects } from "@/hooks/projects/useProjects";
import { useGoBack } from "@/hooks/ui/useGoBack";
import { useSequentialBatch } from "@/hooks/ui/useSequentialBatch";
import { useDeleteWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  buildTidyEntries,
  groupByProject,
  projectCount,
  safeToRemove,
  sortTidyEntries,
  sumBytes,
  summarize,
  type TidyEntry,
  type TidySort,
} from "./tidyModel";
import { TidyConfirm } from "./TidyConfirm";
import {
  TidyBodyView,
  TidyGroupView,
  TidyListView,
  TidyPageView,
} from "./TidyForestView";
import { TidyGroupHeadingView } from "./TidyGroupHeadingView";
import { TidyRow } from "./TidyRow";
import { withToggled } from "@/lib/toggleSet";

// One shared object for every un-started row: a fresh literal per render
// would give all 40 rows a new `status` prop each time a disk walk
// lands, defeating the memoization that keeps the list cheap.
const IDLE: RowStatus = { kind: "idle" };

// The whole forest at once: every worktree of every registered project,
// what it costs on disk, how stale it is, and whether its work already
// landed. Scoped to a machine rather than to one project because that
// is the question being asked. Disk fills up per machine, and the
// worktree worth removing first is rarely in the repo you happen to
// have open. One tab per machine on the account (this one first, the
// pick shared with the Settings host sections beside it), each
// with its own forest under it: every read and every removal below
// rides the host scope the tab mounts.
export function TidyForest() {
  const tabs = useDeviceTabs();
  // The device the Settings host sections show, which opens on this
  // device: one pick for Tidy and those sections, so stepping between
  // them stays on the same machine. A hostless client, which has no
  // device of its own, opens on its first peer.
  const picked = useHostDevicePick(tabs);
  const tabbed = tabs.length > 1 && picked !== undefined;
  // One tree position for the body whether or not the registry has
  // answered yet (a hostless client's list starts empty): this device,
  // the default scope, until there is a pick.
  const shown: DeviceTab = picked ?? {
    deviceId: localDeviceId,
    label: "",
    icon: "desktop",
    isThisDevice: true,
    status: null,
    api: window.api,
    block: undefined,
  };
  return (
    <TidyPageView
      tabs={
        tabbed ? (
          <DeviceTabBarView
            tabs={tabs}
            selectedId={picked.deviceId}
            onSelect={pickHostDevice}
          />
        ) : undefined
      }
    >
      <DeviceTabPanel tab={shown} subject="its forest">
        <TidyBody />
      </DeviceTabPanel>
    </TidyPageView>
  );
}

// The forest of whichever device the surrounding scope names.
function TidyBody() {
  const queryClient = useQueryClient();
  const { keys } = useHostScope();
  const { data: allProjects = [], isLoading: projectsLoading } = useProjects();
  // A project whose folder has moved or been deleted answers every git
  // call with ENOENT. The sidebar already flags those, so here they are
  // simply left out and one broken entry can't fill the page with rows
  // that can't be judged.
  const projects = allProjects.filter(
    (project) => project.pathExists !== false,
  );
  const worktreeQueries = useAllProjectWorktrees(projects);
  const hygiene = useAllProjectHygiene(projects);
  const { data: globalConfig } = useGlobalConfig();

  // Primary checkouts are left out everywhere on this page, not just
  // from the list: they can never be removed, so counting the biggest
  // directory each project owns towards a headline total sitting next to
  // a Remove button would promise back disk that tidying can't return.
  // Filtered once here, so the stats, the disk walks and the rows all
  // describe the same set.
  const worktreesByProject = new Map<string, readonly Worktree[]>(
    projects.map((project, index) => [
      project.id,
      (worktreeQueries[index]?.data ?? []).filter(
        (worktree) => !worktree.isPrimary,
      ),
    ]),
  );
  const allWorktrees = [...worktreesByProject.values()].flat();
  const disk = useWorktreeDiskUsage(allWorktrees);

  const [sort, setSort] = useState<TidySort>("recommended");
  // null means "the user hasn't touched the selection", so the safe-only
  // default keeps tracking the data as hygiene facts arrive. The first
  // toggle materializes it and from then on the user is in charge.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { status, batchRunning, runBatch } = useSequentialBatch();
  // Once a batch has run, the page behind may be one it removed.
  const goBack = useGoBack({ home: status.size > 0 });
  const deleteWorktree = useDeleteWorktree();

  const entries = buildTidyEntries(
    projects,
    worktreesByProject,
    hygiene.byId,
    disk.byId,
    disk.failed,
  );
  const ordered = sortTidyEntries(entries, sort);
  const candidates = safeToRemove(entries);
  const safeIds = new Set(candidates.map((entry) => entry.worktree.id));
  const selected = picked ?? safeIds;
  const summary = summarize(entries, selected);
  const deleteBranches = globalConfig?.deleteBranchOnRemove ?? true;
  const loading =
    projectsLoading ||
    (entries.length === 0 && worktreeQueries.some((query) => query.isPending));

  const statusOf = (worktreeId: string) => status.get(worktreeId) ?? IDLE;

  const toggle = (worktreeId: string) => {
    // Null picked means "everything safe is selected", so seed from
    // that before flipping the one the user clicked.
    setPicked((prev) => withToggled(worktreeId)(prev ?? safeIds));
  };

  const runRemovals = async () => {
    setConfirming(false);
    // Snapshot the selection so toggles during the run can't drift it.
    const queue = summary.selected;
    await runBatch(
      queue,
      (entry) => entry.worktree.id,
      async (entry) => {
        const result = await deleteWorktree.mutateAsync({
          projectId: entry.project.id,
          worktreeId: entry.worktree.id,
          // Force only where the user explicitly acknowledged losing
          // work, and let the verdict decide what counts: untracked
          // files under `-uno` make git refuse without --force while
          // changedCount reads zero.
          force: entry.verdict.needsForce,
        });
        // Deletion resolves either way: `ok: false` means a teardown
        // script or a port release failed and the worktree is still on
        // disk. Raising it here is what marks the row failed instead of
        // "Removed", and keeps its bytes out of the freed total.
        if (!result.ok) {
          throw new Error(
            result.cleanupError.phase === "teardown"
              ? "Teardown script failed. The worktree is still on disk."
              : "Releasing its ports failed. The worktree is still on disk.",
          );
        }
      },
    );
    // Removing a worktree doesn't change any *other* worktree's facts,
    // but the primary-ref comparison is per project and the row is gone
    // either way. Refetching the projects we touched keeps the counts
    // and the "safe to remove" tally honest without re-probing repos the
    // run never went near.
    for (const projectId of new Set(queue.map((entry) => entry.project.id))) {
      void queryClient.invalidateQueries({
        queryKey: keys.worktreeHygiene(projectId),
      });
    }
    setPicked(new Set());
  };

  const list = (rows: TidyEntry[], showProject: boolean) => (
    <TidyListView>
      {rows.map((entry) => (
        <TidyRow
          key={entry.worktree.id}
          entry={entry}
          checked={selected.has(entry.worktree.id)}
          status={statusOf(entry.worktree.id)}
          disabled={batchRunning}
          onToggle={() => toggle(entry.worktree.id)}
          showProject={showProject}
        />
      ))}
    </TidyListView>
  );

  return (
    <TidyBodyView
      disk={disk}
      projectCount={projectCount(entries)}
      worktreeCount={entries.length}
      dirtyCount={
        entries.filter((entry) => entry.worktree.changedCount > 0).length
      }
      safeCount={candidates.length}
      reclaimable={sumBytes(candidates)}
      loading={loading}
      hygieneLoading={hygiene.loading}
      noProjects={projects.length === 0}
      sort={sort}
      onSort={setSort}
      selectedCount={selected.size}
      batchRunning={batchRunning}
      // Clearing is available whenever something is ticked, even where
      // nothing was safe enough to offer in the first place.
      onToggleSelection={() =>
        setPicked(selected.size > 0 ? new Set() : safeIds)
      }
      onBack={goBack}
      onRemove={() => setConfirming(true)}
      lists={
        sort === "project"
          ? groupByProject(ordered).map((group) => (
              <TidyGroup key={group.project.id} group={group}>
                {list(group.entries, false)}
              </TidyGroup>
            ))
          : list(ordered, true)
      }
      confirm={
        confirming && (
          <TidyConfirm
            summary={summary}
            deleteBranches={deleteBranches}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void runRemovals()}
          />
        )
      }
    />
  );
}

// One project's block of rows, under its heading with the project's icon.
function TidyGroup({
  group,
  children,
}: {
  group: ReturnType<typeof groupByProject>[number];
  children: ReactNode;
}) {
  return (
    <TidyGroupView
      heading={
        <TidyGroupHeadingView
          project={group.project}
          count={group.entries.length}
          bytes={group.bytes}
          icon={
            <ProjectIcon
              projectId={group.project.id}
              name={group.project.name}
              className="size-3"
            />
          }
        />
      }
    >
      {children}
    </TidyGroupView>
  );
}
