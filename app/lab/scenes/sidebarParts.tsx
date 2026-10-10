// The sidebar's parts no settled sidebar shows at rest: its menus drawn
// open, the New worktree list, a page's takeover, a drag, arranging,
// and the marks a quiet fixture forest has no row for.
import type { ReactNode } from "react";
import { ActivityIconView } from "@/components/sidebar/ActivityIconView";
import { AgentWaitingMarkView } from "@/components/sidebar/AgentWaitingMarkView";
import { MirrorBadgeView } from "@/components/sidebar/DeviceBadgeView";
import { DeviceMenuRowView } from "@/components/sidebar/DeviceMenuRowView";
import {
  CreateMenuListView,
  CreateMenuView,
  CreateTargetItemView,
} from "@/components/sidebar/inbox/NewWorktreeButtonView";
import { ProjectDragPreviewView } from "@/components/sidebar/ProjectDragPreviewView";
import { SidebarFooterView } from "@/components/sidebar/SidebarFooterView";
import { SidebarHeaderView } from "@/components/sidebar/SidebarHeaderView";
import {
  SidebarTakeoverSlotView,
  SidebarTakeoverView,
} from "@/components/sidebar/SidebarTakeoverView";
import {
  CheckItemView,
  SortOptionsView,
  WorktreeSortMenuView,
  WorktreeSortSubmenuView,
} from "@/components/sidebar/SidebarToolbarView";
import {
  WorktreesErrorView,
  WorktreesLoadingView,
} from "@/components/sidebar/SidebarRowsView";
import { StatusIndicatorView } from "@/components/sidebar/StatusIndicatorView";
import { ProjectIconView } from "@shigomori/ui/views/shared/ProjectIconView.tsx";
import {
  DropdownMenuItem,
  StaticMenu,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { LOCAL_DEVICE_ID, THINKPAD_ID } from "../fake-host/fixtures";
import { projectRows } from "./sidebar";
import {
  deviceById,
  projectIconSrc,
  projectNamed,
  worktreeNamed,
} from "./world";

const noop = () => {};
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

export function SidebarPartsScene() {
  const thinkpad = deviceById(THINKPAD_ID);
  const badge = {
    deviceId: thinkpad.deviceId,
    label: thinkpad.label,
    icon: thinkpad.icon,
    tone: thinkpad.status.tone,
    reachable: thinkpad.status.reachable,
  };
  const worktree = worktreeNamed(SM, "happy-hummingbird");
  return (
    <div
      data-sidebar
      className="grid h-full grid-cols-3 gap-6 bg-background p-6 text-foreground"
    >
      <div className="flex flex-col gap-6">
        <Part label="Sort">
          <StaticMenu>
            <SortOptionsView
              options={[
                { value: "name", label: "Name" },
                { value: "recent", label: "Most recently active" },
              ]}
              value="name"
              onPick={noop}
            />
            <CheckItemView checked onClick={noop}>
              Group by owner
            </CheckItemView>
            <WorktreeSortSubmenuView sort="name" onPick={noop} />
            <DropdownMenuItem variant="destructive">
              <DeviceMenuRowView
                icon={thinkpad.icon}
                label={thinkpad.label}
                note="via terrier"
              />
            </DropdownMenuItem>
          </StaticMenu>
          <WorktreeSortMenuView sort="recent" onPick={noop} />
        </Part>
        <Part label="Marks">
          <span className="flex items-center gap-2 text-3xs">
            <ActivityIconView kind="setup" />
            <ActivityIconView kind="failed" />
            <MirrorBadgeView mirror={badge} showBadge />
            <AgentWaitingMarkView worktree={worktreeNamed(SM, "quiet-quail")} />
            <StatusIndicatorView worktree={worktree} />
          </span>
        </Part>
        <Part label="Dragging">
          <ProjectDragPreviewView project={SM} />
        </Part>
        <Part label="Listing">
          <WorktreesLoadingView />
          <WorktreesErrorView />
        </Part>
      </div>
      <Part label="New worktree in">
        <CreateMenuView
          open={false}
          onOpenChange={noop}
          inputRef={{ current: null }}
          list={null}
        />
        <div className="overflow-hidden rounded-lg border border-border bg-popover">
          <CreateMenuListView
            query=""
            onQueryChange={noop}
            sections={[
              {
                key: "all",
                label: null,
                rows: projectRows(),
              },
            ]}
            renderRow={(target) => (
              <CreateTargetItemView
                key={target.key}
                value={target.key}
                name={target.project.name}
                busy={false}
                disabled={false}
                onSelect={noop}
                icon={
                  <ProjectIconView
                    src={projectIconSrc(target.project.name)}
                    name={target.project.name}
                  />
                }
              />
            )}
          />
        </div>
      </Part>
      <div className="flex flex-col gap-6">
        <Part label="Dev build">
          <SidebarHeaderView hasLocalHost showDevStyle onRevealProd={noop} />
        </Part>
        <Part label="A page's list">
          <SidebarTakeoverSlotView>
            <SidebarTakeoverView back={{ label: "Back", onClick: noop }}>
              <p className="px-3 text-xs">Settings sections</p>
            </SidebarTakeoverView>
          </SidebarTakeoverSlotView>
        </Part>
        <Part label="Arranging">
          <SidebarFooterView
            onDoneArranging={noop}
            toggle={null}
            actions={null}
          />
        </Part>
      </div>
    </div>
  );
}
