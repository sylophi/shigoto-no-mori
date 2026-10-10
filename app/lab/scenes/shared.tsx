// The parts every page shares: a project page's frame with its device
// tabs, the marks for devices, projects, worktrees, villagers and
// tools, and the two folder pickers.
import type { ReactNode } from "react";
import { DEVICE_ICONS } from "@shigomori/contracts/deviceIcon";
import type { Worktree } from "@shigomori/contracts/schemas";
import { BranchComboboxView } from "@/components/shared/BranchComboboxView";
import { CustomLauncherInputView } from "@/components/shared/CustomLauncherInputView";
import { DeviceChipView } from "@/components/shared/DeviceChipView";
import {
  DeviceGlyphView,
  DeviceLeadView,
  DeviceMarkView,
} from "@/components/shared/DeviceGlyphView";
import {
  DeviceTabBarView,
  DeviceTabNoteView,
  StaleDeviceNoteView,
} from "@/components/shared/DeviceTabBarView";
import { EditorFooterView } from "@/components/shared/EditorFooterView";
import {
  BROWSE_VALUE_PREFIX,
  FolderPickerView,
} from "@/components/shared/FolderPickerView";
import { LauncherIconView } from "@/components/shared/LauncherIconView";
import { PageShellView } from "@/components/shared/PageShellView";
import { PathPickerView } from "@/components/shared/PathPickerView";
import { PinnedMarkView } from "@/components/shared/PinnedMarkView";
import { ProjectDevicePageView } from "@/components/shared/ProjectDevicePageView";
import { ProjectIconView } from "@/components/shared/ProjectIconView";
import { ScriptEnvPopoverView } from "@/components/shared/ScriptEnvPopoverView";
import { ScriptStatusBadgeView } from "@/components/shared/ScriptStatusBadgeView";
import { TerrierPawView } from "@/components/shared/TerrierPawView";
import { ToggleRowView } from "@/components/shared/ToggleRowView";
import { VillagerIconView } from "@/components/shared/VillagerIconView";
import {
  VillagerFaceView,
  VillagerSaysView,
} from "@/components/shared/VillagerSaysView";
import { WorktreeKindIconView } from "@/components/shared/WorktreeKindIconView";
import { WorktreeMissingView } from "@/components/shared/WorktreeMissingView";
import { WorktreeMoveDetailsView } from "@/components/shared/WorktreeMoveDetailsView";
import type { ScriptRunState } from "@/store/scriptRuns";
import { LOCAL_DEVICE_ID, MINI_ID, THINKPAD_ID } from "../fake-host/fixtures";
import { SceneDialog, SceneWindowFrame } from "./frame";
import { SceneSidebar } from "./sidebar";
import {
  deviceById,
  deviceTabs,
  FACE,
  projectIconSrc,
  projectNamed,
  worktreeNamed,
} from "./world";

const noop = () => {};
const NOW = Date.now();
const MINUTE = 60_000;

// A script that has run nothing yet (the store's empty state).
const IDLE_RUN: ScriptRunState = {
  runId: null,
  status: "idle",
  hasOutput: false,
  interactive: false,
  exitCode: null,
  startedAt: null,
  endedAt: null,
  cancelling: false,
};

const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");

// shigoto-no-mori's Configure page, held on three devices: its tabs
// lead the header, this device picked, over a form of the shared parts.
export function ProjectPageScene() {
  return (
    <SceneWindowFrame sidebar={<SceneSidebar view="projects" open />}>
      <ProjectDevicePageView
        projectName={SM.name}
        title="Configure"
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
        body={
          <>
            <StaleDeviceNoteView note="Mini is offline, and its copy of this project loads when it reconnects." />
            <div className="flex flex-col gap-6 p-6">
              <section className="flex items-center justify-between gap-3">
                <BranchComboboxView
                  branches={{ local: ["main", "v3"], remote: [] }}
                  fetching={false}
                  value="main"
                  onChange={noop}
                  className="max-w-64"
                />
                <ScriptEnvPopoverView />
              </section>
              <ToggleRowView
                checked
                onCheckedChange={noop}
                label="Run setup on new worktrees"
                description="The setup script runs in each worktree as it is created."
              />
              <CustomLauncherInputView
                launcher={{
                  id: "lazygit",
                  label: "lazygit",
                  command: "lazygit",
                }}
                onChange={noop}
                onRemove={noop}
              />
            </div>
            <EditorFooterView
              isDirty
              isPending={false}
              isSuccess={false}
              onDiscard={noop}
              onSave={noop}
            />
          </>
        }
      />
    </SceneWindowFrame>
  );
}

// A peer's project page with no tabs to pick: the chip names the peer,
// the eyebrow links back to the page this one is under, and the peer
// won't run commands from here.
export function PeerProjectPageScene() {
  const thinkpad = deviceById(THINKPAD_ID);
  return (
    <SceneWindowFrame
      sidebar={
        <SceneSidebar
          view="inbox"
          selected={worktreeNamed(SM, "happy-hummingbird").id}
        />
      }
    >
      <ProjectDevicePageView
        projectName={SM.name}
        title="Manage branches"
        parent={{ label: "New worktree", onOpen: noop }}
        terrier={false}
        chip={
          <DeviceChipView
            label={thinkpad.label}
            icon={thinkpad.icon}
            status={thinkpad.status}
          />
        }
        showAllDevices={false}
        body={
          <DeviceTabNoteView note="Thinkpad doesn't run commands from this device." />
        }
      />
    </SceneWindowFrame>
  );
}

// A page of its own (PageShellView) for a worktree that's gone.
export function MissingWorktreeScene() {
  return (
    <SceneWindowFrame sidebar={<SceneSidebar view="projects" open />}>
      <PageShellView eyebrow={SM.name} title="happy-hummingbird" watermark="木">
        <WorktreeMissingView
          isPending={false}
          isError={false}
          deleted
          refetch={async () => {}}
          onBack={noop}
        />
      </PageShellView>
    </SceneWindowFrame>
  );
}

function Strip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-24 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const KINDS: Record<string, Partial<Worktree>> = {
  primary: { isPrimary: true },
  external: { isExternal: true },
  agentWorking: { agentWorking: true },
  shelved: { shelved: true },
};

// Every mark, side by side.
export function MarksScene() {
  const worktree = worktreeNamed(SM, "happy-hummingbird");
  return (
    <div className="flex h-full flex-col gap-4 bg-background p-6 text-sm text-foreground">
      <Strip label="Devices">
        {DEVICE_ICONS.map((icon) => (
          <DeviceGlyphView key={icon} icon={icon} className="size-4" />
        ))}
      </Strip>
      <Strip label="Device leads">
        {[LOCAL_DEVICE_ID, THINKPAD_ID, MINI_ID].map((id) => {
          const device = deviceById(id);
          return (
            <span key={id} className="inline-flex items-center gap-3">
              <DeviceLeadView icon={device.icon} tone={device.status.tone} />
              <DeviceMarkView icon={device.icon} tone={device.status.tone} />
            </span>
          );
        })}
      </Strip>
      <Strip label="Projects">
        <ProjectIconView src={undefined} name="loading" className="size-5" />
        <ProjectIconView src={null} name="t3code" className="size-5" />
        <ProjectIconView
          src={projectIconSrc("port-pool")}
          name="port-pool"
          className="size-5"
        />
        <PinnedMarkView />
        <TerrierPawView className="size-4" />
      </Strip>
      <Strip label="Worktrees">
        {Object.entries(KINDS).map(([name, kind]) => (
          <WorktreeKindIconView
            key={name}
            worktree={{ ...worktree, ...kind }}
            allowAgentWorking
          />
        ))}
      </Strip>
      <Strip label="Villagers">
        <VillagerIconView src={FACE} size={24} />
        <VillagerFaceView face={FACE} className="size-7" />
        <span>
          <VillagerSaysView
            line={{ lead: "Committed", tail: ", cardio!", speaker: "Sheldon" }}
          />
        </span>
      </Strip>
      <Strip label="Tools">
        <LauncherIconView
          entry={{
            kind: "detected",
            id: "vscode",
            label: "VS Code",
            available: true,
          }}
        />
        <LauncherIconView
          entry={{ kind: "web", id: "github", label: "GitHub" }}
        />
        <LauncherIconView
          entry={{ kind: "custom", id: "x", label: "lazygit" }}
        />
      </Strip>
      <Strip label="Scripts">
        <ScriptStatusBadgeView
          state={{ ...IDLE_RUN, status: "running", startedAt: NOW - MINUTE }}
        />
        <ScriptStatusBadgeView
          state={{
            ...IDLE_RUN,
            status: "exited",
            exitCode: 1,
            startedAt: NOW - 3 * MINUTE,
            endedAt: NOW - 2 * MINUTE,
          }}
          variant="header"
        />
      </Strip>
      <WorktreeMoveDetailsView
        branch="happy-hummingbird"
        detached={false}
        fromPath="~/dev/sm-hummingbird"
        fromTip="/Users/rin/dev/sm-hummingbird"
        toPath="~/.sm/wt/shigoto-no-mori/happy-hummingbird"
        toTip="/Users/rin/.sm/wt/shigoto-no-mori/happy-hummingbird"
        status={{ kind: "running" }}
        labels={{ running: "Moving", done: "Moved", error: "Couldn't move" }}
      />
    </div>
  );
}

const FOLDERS = ["app", "cli", "docs", "hub", "marketing", "packages"];

// The folder picker, browsing a checkout's parent.
export function FolderPickerScene() {
  const query = "~/dev/";
  return (
    <SceneWindowFrame
      overlays={
        <SceneDialog>
          <FolderPickerView
            title="Pick a folder"
            confirmLabel="Use this folder"
            hint="Where new worktrees of this project go."
            onPick={noop}
            onClose={noop}
            query={query}
            setQuery={noop}
            highlighted={`${BROWSE_VALUE_PREFIX}${query}docs`}
            setHighlighted={noop}
            browse={{
              browseDir: query,
              leafFilter: "",
              listingEnabled: true,
              listing: {
                path: "/Users/rin/dev",
                entries: FOLDERS.map((name) => ({ name, isGitRepo: false })),
              },
              isLoading: false,
              error: null,
              filtered: FOLDERS.map((name) => ({ name, isGitRepo: false })),
              browseTo: noop,
              browseUp: noop,
            }}
            onOpenFinder={noop}
          />
        </SceneDialog>
      }
    />
  );
}

const ENTRIES = [
  { name: "node_modules", isDirectory: true, ignored: true },
  { name: "src", isDirectory: true, ignored: false },
  { name: ".env.local", isDirectory: false, ignored: true },
  { name: "package.json", isDirectory: false, ignored: false },
];

// The carry-over picker's folder browser, one folder in.
export function PathPickerScene() {
  return (
    <SceneWindowFrame
      overlays={
        <SceneDialog>
          <PathPickerView
            rootPath="/Users/rin/dev/shigoto-no-mori"
            home="/Users/rin"
            parents={[{ name: "app", isDirectory: true, ignored: false }]}
            onParentsChange={noop}
            listing={{ data: ENTRIES, isPending: false, error: null }}
            renderTrailing={(entry) =>
              entry.ignored ? (
                <span className="text-xs text-muted-foreground">ignored</span>
              ) : null
            }
            onClose={noop}
          />
        </SceneDialog>
      }
    />
  );
}
