// A project's pages over the fixtures: shigoto-no-mori's Configure
// page and its shared settings, its branches, its worktree location and
// the conversion of its external worktrees, the Tidy page across the
// forest, and the home page's tiles.
import type { ReactNode } from "react";
import { EditorFooterView } from "../views/shared/EditorFooterView.tsx";
import { BranchComboboxView } from "../views/shared/BranchComboboxView.tsx";
import { DeviceTabBarView } from "../views/shared/DeviceTabBarView.tsx";
import { ProjectDevicePageView } from "../views/shared/ProjectDevicePageView.tsx";
import { ProjectIconView } from "../views/shared/ProjectIconView.tsx";
import { WorktreeKindIconView } from "../views/shared/WorktreeKindIconView.tsx";
import { ModalBox } from "../primitives/modal-shell.tsx";
import { CarryOverRowView } from "../views/configure/CarryOverRowView.tsx";
import { CarryOverSectionView } from "../views/configure/CarryOverSectionView.tsx";
import { CarryOverTrailingView } from "../views/configure/CarryOverTrailingView.tsx";
import { ConfigureFormView } from "../views/configure/ConfigureFormView.tsx";
import {
  ConfigureLoadFailureView,
  ConfigureSharedView,
} from "../views/configure/ConfigureProjectView.tsx";
import { ConfigureSkeletonView } from "../views/configure/ConfigureSkeletonView.tsx";
import { CreateOnSectionView } from "../views/configure/CreateOnSectionView.tsx";
import {
  FoundOnDevicesView,
  OnlyInWorktreesView,
} from "../views/configure/OnlyInWorktreesView.tsx";
import { WorktreeLocationFieldView } from "../views/configure/WorktreeLocationFieldView.tsx";
import { ConvertExternalView } from "../views/convertExternal/ConvertExternalView.tsx";
import {
  ProjectGridLayoutView,
  ProjectGridView,
  ProjectTileView,
} from "../views/home/ProjectGridView.tsx";
import {
  BranchDeleteDialogView,
  BranchRowView,
} from "../views/manageBranches/BranchRowView.tsx";
import {
  LocalBranchListView,
  ManageBranchesView,
  RemoteBranchesView,
} from "../views/manageBranches/ManageBranchesView.tsx";
import { NewBranchFormView } from "../views/manageBranches/NewBranchFormView.tsx";
import { TidyConfirmView } from "../views/tidy/TidyConfirmView.tsx";
import {
  TidyBodyView,
  TidyGroupView,
  TidyListView,
  TidyPageView,
} from "../views/tidy/TidyForestView.tsx";
import { TidyGroupHeadingView } from "../views/tidy/TidyGroupHeadingView.tsx";
import { TidyRowView } from "../views/tidy/TidyRowView.tsx";
import {
  buildTidyEntries,
  groupByProject,
  safeToRemove,
  sortTidyEntries,
  sumBytes,
  summarize,
} from "../views/tidy/tidyModel.ts";
import { LeaveOutPickerView } from "../views/worktreeDetail/flow/LeaveOutPickerView.tsx";
import { LocationFormView } from "../views/worktreeLocation/LocationFormView.tsx";
import {
  LocationPaneView,
  LocationSkeletonView,
} from "../views/worktreeLocation/WorktreeLocationView.tsx";
import { LAYOUT_OPTIONS } from "../views/worktreeLocation/layoutOptions.ts";
import type { Worktree } from "@shigomori/contracts/schemas/index";
import {
  forests,
  LOCAL_DEVICE_ID,
  repoDescriptionFor,
  MINI_ID,
  THINKPAD_ID,
} from "../fixtures/fixtures.ts";
import { fakeDiskUsage, fakeHygiene } from "../fixtures/tidyFixtures.ts";
import { SceneWindowFrame } from "./frame.tsx";
import { sceneGrid, SceneSidebar } from "./sidebar.tsx";
import {
  deviceById,
  deviceTabs,
  projectIconSrc,
  projectNamed,
} from "./world.ts";

const noop = () => {};
const HOME = "/Users/rin";
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");
const WORKTREES: Worktree[] = forests[LOCAL_DEVICE_ID]?.worktrees[SM.id] ?? [];
const DEVICE = {
  dataDir: `${HOME}/.sm`,
  canonicalDataDirName: ".sm",
  onProjectDrive: false,
  homedir: HOME,
};
const BRANCHES = {
  local: [
    "main",
    ...WORKTREES.map((w) => w.branch).filter((b) => b !== "main"),
  ],
  remote: ["origin/main", "origin/v2-exp/remote-ui-flows", "origin/gh-pages"],
};

const icon = (name: string) => (
  <ProjectIconView src={projectIconSrc(name)} name={name} className="size-3" />
);

function projectPage(title: string, body: ReactNode) {
  return (
    <SceneWindowFrame
      sidebar={<SceneSidebar view="projects" open />}
      pathname="/projects"
    >
      <ProjectDevicePageView
        projectName={SM.name}
        title={title}
        tabs={
          <DeviceTabBarView
            tabs={deviceTabs([LOCAL_DEVICE_ID, THINKPAD_ID, MINI_ID])}
            selectedId={LOCAL_DEVICE_ID}
            onSelect={noop}
            allDevicesTab
          />
        }
        terrier
        showAllDevices={false}
        body={body}
      />
    </SceneWindowFrame>
  );
}

// shigoto-no-mori's Configure page on this machine.
export function ConfigureScene() {
  return projectPage(
    "Configure",
    <ConfigureFormView
      form={{
        defaultBranch: "main",
        setup: "pnpm install",
        teardown: "",
        launchers: [
          { id: "storybook", label: "Storybook", command: "pnpm storybook" },
        ],
        carryOver: [
          { path: ".env.local", mode: "copy" },
          { path: "node_modules", mode: "symlink" },
        ],
        useWorktreeInclude: true,
        showPrimaryInInbox: false,
      }}
      setForm={noop}
      projectPath={SM.path}
      home={HOME}
      remote={false}
      deviceLabel={deviceById(LOCAL_DEVICE_ID).label}
      onReveal={noop}
      onOpenLaunchTools={noop}
      branchPicker={
        <BranchComboboxView
          id="default-branch"
          branches={BRANCHES}
          fetching={false}
          onOpen={noop}
          value="main"
          onChange={noop}
          placeholder="main"
        />
      }
      location={
        <WorktreeLocationFieldView
          label={LAYOUT_OPTIONS[0]?.label}
          description={LAYOUT_OPTIONS[0]?.description}
          shownPath={null}
          home={HOME}
          blocked={false}
          onChange={noop}
        />
      }
      carryOver={
        <CarryOverSectionView
          entries={[
            { path: ".env.local", mode: "copy" },
            { path: "node_modules", mode: "symlink" },
          ]}
          includePaths={[".claude/settings.local.json"]}
          stats={{
            ".env.local": {
              isDirectory: false,
              inPrimary: true,
              worktrees: [],
            },
            node_modules: {
              isDirectory: true,
              inPrimary: false,
              worktrees: ["happy-hummingbird", "quiet-quail"],
            },
          }}
          isCovered={() => false}
          includeFileExists
          noMatches={false}
          useWorktreeInclude
          onToggleUseWorktreeInclude={noop}
          onChangeMode={noop}
          onRemove={noop}
          onPickPath={noop}
          picker={null}
        />
      }
      saveError={null}
      footer={
        <EditorFooterView
          isDirty
          isPending={false}
          isSuccess={false}
          onDiscard={noop}
          onSave={noop}
        />
      }
    />,
  );
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

// The project's other pages: its shared settings, branches, worktree
// location and external worktrees, and their states.
export function ProjectPagesPartsScene() {
  const mini = deviceById(MINI_ID);
  const thinkpad = deviceById(THINKPAD_ID);
  const here = deviceById(LOCAL_DEVICE_ID);
  const external = WORKTREES.find((w) => w.isExternal) ?? WORKTREES[0];
  const tidy = tidyForest();
  const branchRow = (name: string) => {
    const worktree = WORKTREES.find((w) => w.branch === name);
    return [
      name,
      <BranchRowView
        key={name}
        name={name}
        worktree={worktree}
        kindIcon={
          worktree && (
            <WorktreeKindIconView worktree={worktree} allowAgentWorking />
          )
        }
        draft={name === "port-pool-retry" ? "port-pool-retry-2" : null}
        onDraft={noop}
        renamePending={false}
        onCommitRename={noop}
        onOpenWorktree={noop}
        onDelete={noop}
        deletePending={false}
        deleteDialog={null}
      />,
    ] as const;
  };
  return (
    <div className="grid h-full grid-cols-2 gap-8 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex min-w-0 flex-col gap-8">
        <Part label="All devices">
          <ConfigureSharedView>
            <CreateOnSectionView
              holders={[
                {
                  ...here,
                  isThisDevice: true,
                  block: undefined,
                },
                {
                  ...thinkpad,
                  isThisDevice: false,
                  block: undefined,
                },
                {
                  ...mini,
                  isThisDevice: false,
                  block: "offline",
                },
              ]}
              blockReasons={{
                offline: "Creating needs a live connection.",
                "no-grant": "Read-only from here.",
                "no-project": "No checkout of this repo.",
              }}
              current={MINI_ID}
              waiting={{ picked: mini.label, fallback: here.label }}
              onPick={noop}
            />
            <LeaveOutPickerView
              value={{
                base: "gitignored",
                leftOut: new Set(),
                brought: new Set(),
              }}
              onChange={noop}
              ignored={{ data: undefined, isPending: true, isError: false }}
              note="What every mirror and transplant of this project leaves out."
              onBrowse={noop}
              browser={null}
            />
          </ConfigureSharedView>
        </Part>
        <Part label="Branches">
          <ManageBranchesView
            creating
            onCreate={noop}
            newBranchForm={
              <NewBranchFormView
                name="feat/new-thing"
                onName={noop}
                basePicker={
                  <BranchComboboxView
                    id="new-branch-base"
                    branches={BRANCHES}
                    fetching={false}
                    onOpen={noop}
                    value="main"
                    onChange={noop}
                  />
                }
                canSubmit
                pending={false}
                onSubmit={noop}
                onCancel={noop}
              />
            }
            localNames={BRANCHES.local}
            rows={new Map(BRANCHES.local.map(branchRow))}
            remotes={BRANCHES.remote}
          />
          <LocalBranchListView names={[]} rows={new Map()} />
          <RemoteBranchesView names={BRANCHES.remote} />
        </Part>
        <Part label="Deleting an unmerged branch">
          <ModalBox className="max-w-md">
            <BranchDeleteDialogView
              name="exp/terrier-sync"
              needsForce
              error={{ notMerged: true, message: "" }}
              pending={false}
              onCancel={noop}
              onDelete={noop}
            />
          </ModalBox>
        </Part>
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <Part label="Worktree location">
          <LocationPaneView>
            <LocationFormView
              layout="custom"
              onLayout={noop}
              projectPath={SM.path}
              device={DEVICE}
              customPath="/Volumes/Work/worktrees"
              customPathError={null}
              onOpenPicker={noop}
              toMove={WORKTREES.filter((w) => !w.isPrimary && !w.isExternal)
                .slice(0, 2)
                .map((worktree) => ({
                  worktree,
                  destination: `/Volumes/Work/worktrees/${worktree.name}`,
                }))}
              status={new Map()}
              saveError={null}
              canSubmit
              batchRunning={false}
              submitLabel="Move 2 worktrees"
              onBack={noop}
              onApply={noop}
              picker={null}
            />
          </LocationPaneView>
          <LocationSkeletonView />
        </Part>
        <Part label="Converting external worktrees">
          {external && (
            <ConvertExternalView
              externals={[external]}
              isLoading={false}
              selected={new Set([external.id])}
              status={new Map()}
              batchRunning={false}
              proposedPaths={
                new Map([
                  [
                    external.id,
                    `~/.sm/worktrees/shigoto-no-mori/${external.branch}`,
                  ],
                ])
              }
              home={HOME}
              onToggle={noop}
              onToggleAll={noop}
              onBack={noop}
              onConvert={noop}
            />
          )}
        </Part>
        <Part label="Tidying">
          <ModalBox className="max-w-lg">
            <TidyConfirmView
              summary={summarize(tidy.entries, tidy.selected)}
              deleteBranches
              icons={new Map(tidy.projects.map((p) => [p.id, icon(p.name)]))}
              onCancel={noop}
              onConfirm={noop}
            />
          </ModalBox>
        </Part>
        <Part label="Carry-over, loading and failing">
          <div className="flex flex-wrap items-center gap-2">
            <CarryOverTrailingView
              added
              covered={false}
              ignored
              onPick={noop}
            />
            <CarryOverTrailingView
              added={false}
              covered
              ignored
              onPick={noop}
            />
            <CarryOverTrailingView
              added={false}
              covered={false}
              ignored
              onPick={noop}
            />
            <CarryOverTrailingView
              added={false}
              covered={false}
              ignored={false}
              onPick={noop}
            />
          </div>
          <CarryOverRowView
            entry={{ path: ".env", mode: "copy" }}
            stat={undefined}
            covered
          />
          <OnlyInWorktreesView inPrimary={false} worktrees={["quiet-quail"]} />
          <FoundOnDevicesView
            holders={[
              { device: thinkpad.label, inPrimary: true, worktrees: [] },
              { device: mini.label, inPrimary: false, worktrees: ["fox"] },
            ]}
          />
          <ConfigureLoadFailureView
            message="The project file isn't valid JSON."
            onRetry={noop}
          />
          <ConfigureSkeletonView />
        </Part>
      </div>
    </div>
  );
}

// The forest's worktrees as the Tidy page judges them, with the
// merged one ticked.
function tidyForest() {
  const projects = forests[LOCAL_DEVICE_ID]?.projects ?? [];
  const byProject = new Map(
    projects.map((project) => [
      project.id,
      (forests[LOCAL_DEVICE_ID]?.worktrees[project.id] ?? []).filter(
        (w) => !w.isPrimary,
      ),
    ]),
  );
  const all = [...byProject.values()].flat();
  const merged = new Set(["fix-stale-locks"]);
  const entries = buildTidyEntries(
    projects,
    byProject,
    new Map(all.map((w) => [w.id, fakeHygiene(w, merged)])),
    new Map(all.map((w, i) => [w.id, fakeDiskUsage(w, i)])),
    new Set(),
  );
  const safe = safeToRemove(entries);
  return {
    projects,
    entries,
    safe,
    selected: new Set(safe.map((entry) => entry.worktree.id)),
  };
}

// The forest's worktrees, measured and judged: the merged ones ticked
// to remove, sorted by project.
export function TidyScene() {
  const { entries, safe, selected } = tidyForest();
  const groups = groupByProject(sortTidyEntries(entries, "project"));
  const total = entries.reduce(
    (sum, entry) => sum + (entry.disk?.reclaimableBytes ?? 0),
    0,
  );
  return (
    <SceneWindowFrame sidebar={<SceneSidebar view="inbox" />} pathname="/tidy">
      <TidyPageView
        tabs={
          <DeviceTabBarView
            tabs={deviceTabs([LOCAL_DEVICE_ID, THINKPAD_ID, MINI_ID])}
            selectedId={LOCAL_DEVICE_ID}
            onSelect={noop}
          />
        }
      >
        <TidyBodyView
          disk={{
            measuredBytes: total,
            measuredCount: entries.length,
            totalCount: entries.length,
            measuring: false,
            partial: false,
          }}
          projectCount={groups.length}
          worktreeCount={entries.length}
          dirtyCount={entries.filter((e) => e.worktree.changedCount > 0).length}
          safeCount={safe.length}
          reclaimable={sumBytes(safe)}
          loading={false}
          hygieneLoading={false}
          noProjects={false}
          sort="project"
          onSort={noop}
          selectedCount={selected.size}
          batchRunning={false}
          onToggleSelection={noop}
          onBack={noop}
          onRemove={noop}
          lists={groups.map((group) => (
            <TidyGroupView
              key={group.project.id}
              heading={
                <TidyGroupHeadingView
                  project={group.project}
                  count={group.entries.length}
                  bytes={group.bytes}
                  icon={icon(group.project.name)}
                />
              }
            >
              <TidyListView>
                {group.entries.map((entry) => (
                  <TidyRowView
                    key={entry.worktree.id}
                    entry={entry}
                    checked={selected.has(entry.worktree.id)}
                    status={
                      entry.worktree.name === "quiet-quail"
                        ? {
                            kind: "error",
                            message: "Teardown script failed.",
                            error: null,
                          }
                        : { kind: "idle" }
                    }
                    disabled={false}
                    onToggle={noop}
                    showProject={false}
                    icon={icon(entry.project.name)}
                  />
                ))}
              </TidyListView>
            </TidyGroupView>
          ))}
          confirm={null}
        />
      </TidyPageView>
    </SceneWindowFrame>
  );
}

// The home page's tiles, the projects on this machine and its peers.
export function HomeScene() {
  const { sections, work } = sceneGrid();
  return (
    <SceneWindowFrame sidebar={<SceneSidebar view="inbox" />} pathname="/">
      <ProjectGridView
        grid={
          <ProjectGridLayoutView
            sections={sections}
            columns={2}
            tiles={
              new Map(
                sections.flatMap((section) =>
                  section.rows.map((row) => [
                    row.key,
                    <ProjectTileView
                      key={row.key}
                      row={row}
                      work={work.get(row.groupKey)}
                      showBadges
                      description={repoDescriptionFor(row.project.name)}
                      missing={row.project.pathExists === false}
                      relocating={false}
                      onLocate={undefined}
                      unlisted={false}
                      onOpen={noop}
                      onHover={noop}
                      triggerRef={{ current: null }}
                      icon={
                        <ProjectIconView
                          src={projectIconSrc(row.project.name)}
                          name={row.project.name}
                          className="size-8"
                        />
                      }
                      actions={null}
                      picker={null}
                    />,
                  ]),
                ),
              )
            }
          />
        }
        empty={null}
      />
    </SceneWindowFrame>
  );
}

// The home page with nothing on the picked device.
export function HomeEmptyScene() {
  return (
    <div className="h-full bg-background text-foreground">
      <ProjectGridView grid={null} empty="No projects on Mini." />
    </div>
  );
}
