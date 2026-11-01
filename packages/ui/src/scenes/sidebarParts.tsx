// The sidebar's parts no settled sidebar shows at rest: its menus drawn
// open, the New worktree list, a page's takeover, a drag, arranging,
// and the marks a quiet fixture forest has no row for.
import { ActivityIconView } from "../views/sidebar/ActivityIconView.tsx";
import { TerminalMarkView } from "../views/sidebar/TerminalMarkView.tsx";
import { AgentWaitingMarkView } from "../views/sidebar/AgentWaitingMarkView.tsx";
import { MirrorBadgeView } from "../views/sidebar/DeviceBadgeView.tsx";
import { DeviceMenuRowView } from "../views/sidebar/DeviceMenuRowView.tsx";
import {
  CreateMenuListView,
  CreateMenuView,
  CreateTargetItemView,
} from "../views/sidebar/inbox/NewWorktreeButtonView.tsx";
import { ProjectDragPreviewView } from "../views/sidebar/ProjectDragPreviewView.tsx";
import {
  SidebarFooterView,
  SidebarGuideMenuItemsView,
} from "../views/sidebar/SidebarFooterView.tsx";
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
import {
  WorktreeMenuLeadView,
  WorktreeMenuManageView,
  WorktreeMenuTransfersView,
} from "../views/sidebar/WorktreeMenuView.tsx";
import { ProjectIconView } from "../views/shared/ProjectIconView.tsx";
import { DropdownMenuItem, StaticMenu } from "../primitives/dropdown-menu.tsx";
import { LOCAL_DEVICE_ID, MACBOOK_ID } from "../fixtures/fixtures.ts";
import { projectRows } from "./sidebar.tsx";
import { deviceById, noop, projectNamed, worktreeNamed } from "./world.ts";
import { ScenePart } from "./frame.tsx";

const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");

export function SidebarPartsScene() {
  const macbook = deviceById(MACBOOK_ID);
  const badge = {
    deviceId: macbook.deviceId,
    label: macbook.label,
    icon: macbook.icon,
    tone: macbook.status.tone,
    reachable: macbook.status.reachable,
  };
  const worktree = worktreeNamed(SM, "happy-hummingbird");
  return (
    <div
      data-sidebar
      className="grid h-full grid-cols-3 gap-6 bg-background p-6 text-foreground"
    >
      <div className="flex flex-col gap-6">
        <ScenePart label="Sort">
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
              <DeviceMenuRowView icon={macbook.icon} label={macbook.label} />
            </DropdownMenuItem>
          </StaticMenu>
          <WorktreeSortMenuView sort="recent" onPick={noop} />
        </ScenePart>
        <ScenePart label="Guide menu">
          <StaticMenu>
            <SidebarGuideMenuItemsView
              choices={{ harnesses: ["claude", "codex"], terminals: [] }}
              onPick={noop}
            />
          </StaticMenu>
        </ScenePart>
        <ScenePart label="Worktree menu">
          <StaticMenu>
            <WorktreeMenuLeadView
              onGoToProject={noop}
              pullRequest={{ number: 142, url: "" }}
              path={worktree.path}
              branch={worktree.branch}
            />
            <WorktreeMenuTransfersView
              mirror={{ disabled: false, onClick: noop }}
              onTransplant={noop}
            />
            <WorktreeMenuManageView
              autoPull={{ checked: true, disabled: false, onChange: noop }}
              shelve={{ shelved: false, disabled: false, onToggle: noop }}
              remove={{ armed: false, disabled: false, onClick: noop }}
            />
          </StaticMenu>
        </ScenePart>
        <ScenePart label="Marks">
          <span className="flex items-center gap-2 text-3xs">
            <ActivityIconView kind="setup" />
            <ActivityIconView kind="failed" />
            <TerminalMarkView mark="open" />
            <TerminalMarkView mark="busy" />
            <MirrorBadgeView mirror={badge} showBadge />
            <AgentWaitingMarkView worktree={worktreeNamed(SM, "quiet-quail")} />
            <StatusIndicatorView worktree={worktree} />
            <StatusIndicatorView
              worktree={{ ...worktree, changedCount: null }}
            />
          </span>
        </ScenePart>
        <ScenePart label="Dragging">
          <ProjectDragPreviewView project={SM} />
        </ScenePart>
        <ScenePart label="Listing">
          <WorktreesLoadingView />
          <WorktreesErrorView />
        </ScenePart>
      </div>
      <ScenePart label="New worktree in">
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
                icon={<ProjectIconView src={null} name={target.project.name} />}
              />
            )}
          />
        </div>
      </ScenePart>
      <div className="flex flex-col gap-6">
        <ScenePart label="Dev build">
          <SidebarHeaderView hasLocalHost showDevStyle onRevealProd={noop} />
        </ScenePart>
        <ScenePart label="A page's list">
          <SidebarTakeoverSlotView>
            <SidebarTakeoverView back={{ label: "Back", onClick: noop }}>
              <p className="px-3 text-xs">Settings sections</p>
            </SidebarTakeoverView>
          </SidebarTakeoverSlotView>
        </ScenePart>
        <ScenePart label="Arranging">
          <SidebarFooterView
            onDoneArranging={noop}
            toggle={null}
            actions={null}
          />
        </ScenePart>
      </div>
    </div>
  );
}
