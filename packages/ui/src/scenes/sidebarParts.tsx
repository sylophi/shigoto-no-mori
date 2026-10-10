// The sidebar's parts no settled sidebar shows at rest: its menus drawn
// open, the New worktree list, a page's takeover, a drag, arranging,
// and the marks a quiet fixture forest has no row for.
import type { ReactNode } from "react";
import { ActivityIconView } from "../views/sidebar/ActivityIconView.tsx";
import { AgentWaitingMarkView } from "../views/sidebar/AgentWaitingMarkView.tsx";
import { MirrorBadgeView } from "../views/sidebar/DeviceBadgeView.tsx";
import { DeviceMenuRowView } from "../views/sidebar/DeviceMenuRowView.tsx";
import {
  CreateMenuListView,
  CreateMenuView,
  CreateTargetItemView,
} from "../views/sidebar/inbox/NewWorktreeButtonView.tsx";
import { ProjectDragPreviewView } from "../views/sidebar/ProjectDragPreviewView.tsx";
import { SidebarFooterView } from "../views/sidebar/SidebarFooterView.tsx";
import { SidebarHeaderView } from "../views/sidebar/SidebarHeaderView.tsx";
import {
  SidebarTakeoverSlotView,
  SidebarTakeoverView,
} from "../views/sidebar/SidebarTakeoverView.tsx";
import {
  CheckItemView,
  SortOptionsView,
  WorktreeSortMenuView,
  WorktreeSortSubmenuView,
} from "../views/sidebar/SidebarToolbarView.tsx";
import {
  WorktreesErrorView,
  WorktreesLoadingView,
} from "../views/sidebar/SidebarRowsView.tsx";
import { StatusIndicatorView } from "../views/sidebar/StatusIndicatorView.tsx";
import { ProjectIconView } from "../views/shared/ProjectIconView.tsx";
import { DropdownMenuItem, StaticMenu } from "../primitives/dropdown-menu.tsx";
import { LOCAL_DEVICE_ID, THINKPAD_ID } from "../fixtures/fixtures.ts";
import { projectRows } from "./sidebar.tsx";
import {
  deviceById,
  projectIconSrc,
  projectNamed,
  worktreeNamed,
} from "./world.ts";

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
