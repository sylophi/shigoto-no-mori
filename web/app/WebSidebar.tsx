// The web client's sidebar: the browser twin of the desktop's
// sidebar/Sidebar.tsx, carrying the same chrome contract (data-sidebar
// token overrides, the doubutsu "sidebar" zone, the brand header with
// both themes' markup side by side, a scrollable list over a footer of
// nav icon buttons). Where the desktop lists projects and worktrees,
// the web lists the account's other devices -- the forests this client
// can actually reach -- each row opening that device's forest page.
import { useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  FolderGit2,
  LogOut,
  MonitorSmartphone,
  Settings as SettingsIcon,
} from "lucide-react";
import type { DeviceInfo } from "@shared/relay/protocol";
import type { Project, Worktree } from "@shared/schemas";
import { NavIconButton } from "@/components/sidebar/NavIconButton";
import { SIDEBAR_ICON_BUTTON } from "@/components/sidebar/sidebarChrome";
import { BranchLabel } from "@/components/ui/branch-label";
import { StatusDot } from "@/components/ui/status-dot";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useAccountDevices,
  useAccountStatus,
} from "@/hooks/account/useAccount";
import { useClerkSignOut } from "@/hooks/account/useClerkAccount";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import {
  remoteProjectsQueryOptions,
  useAllRemoteWorktrees,
} from "@/hooks/remote/useRemoteForest";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";
import { navigateTo, redirectTo, webPaths } from "./nav";

export function WebSidebar() {
  const { data: status } = useAccountStatus();
  const signedIn = status?.signedIn === true;

  return (
    <aside
      data-sidebar
      data-doubutsu-zone="sidebar"
      className="flex h-full flex-col"
    >
      <WebSidebarHeader />
      <div className="min-h-0 flex-1">
        <ScrollArea className="size-full">
          {signedIn ? (
            <DeviceList />
          ) : (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Sign in to reach this account&apos;s devices.
            </p>
          )}
        </ScrollArea>
      </div>
      <WebSidebarFooter signedIn={signedIn} />
    </aside>
  );
}

// The desktop SidebarHeader's two-theme brand, minus its window chrome
// (drag regions, the traffic-light inset): a browser tab has neither.
// The dev sticker slot instead marks this build as the web client. Both
// headers always render; `doubutsu-only` / `v1-only` pick which shows,
// exactly like the desktop component (a JS theme branch would fork the
// markup per theme and be invisible to `pnpm theme:check`).
function WebSidebarHeader() {
  return (
    <>
      <div className="doubutsu-only relative mx-3 mt-3 mb-2 overflow-hidden rounded-2xl bg-card px-5 pt-4 pb-5">
        <h1 className="relative z-[1] text-[28px] leading-none font-black tracking-tight text-foreground">
          仕事の森
        </h1>
        <span className="relative z-[1] mt-1.5 block text-[12px] font-bold text-muted-foreground">
          Shigoto no Mori
        </span>
        <span className="absolute top-3 right-3 z-[2] -rotate-6 rounded-full bg-secondary px-2 py-[3px] text-[10px] leading-none font-black tracking-widest text-secondary-foreground uppercase">
          web
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute -right-4 -bottom-10 text-[140px] leading-none font-black text-[var(--doubutsu-watermark)] opacity-15 select-none"
        >
          森
        </span>
      </div>
      <div className="v1-only flex h-[52px] items-center gap-2 px-4">
        <div className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">
          Shigoto no Mori
        </div>
        <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] leading-none font-medium tracking-widest text-muted-foreground uppercase">
          web
        </span>
      </div>
    </>
  );
}

// The account's other devices, merged with the live relay roster for
// the status dot -- same derivation as the devices page, so the two
// surfaces can never disagree about a device's state. Each device row
// heads its remote forest: projects with their worktrees nested under
// it, the web twin of the desktop sidebar's project tree (which lists
// the LOCAL forest -- content a browser doesn't have). Rows always
// navigate to the device's forest page: it renders the honest status
// panel for an unreachable device, which beats a dead row.
function DeviceList() {
  const devices = useAccountDevices(true);
  const peers = (devices.data ?? []).filter(
    (device) => device.deviceId !== window.api.deviceId,
  );

  return (
    <nav aria-label="Devices" className="flex flex-col gap-1 px-2 py-1">
      <h2 className="px-1 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Devices
      </h2>
      {devices.isPending ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          Loading devices&hellip;
        </p>
      ) : devices.isError ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          Couldn&apos;t load this account&apos;s devices.
        </p>
      ) : peers.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          No other devices yet. Sign in from the desktop app to enroll a
          machine.
        </p>
      ) : (
        peers.map((device) => (
          <DeviceGroup key={device.deviceId} info={device} />
        ))
      )}
    </nav>
  );
}

function DeviceGroup({ info }: { info: DeviceInfo }) {
  const { pathname } = useLocation();
  const path = webPaths.deviceForest(info.deviceId);
  const active = pathname === path;
  const entry = useRemoteDevices().find(
    (device) => device.deviceId === info.deviceId,
  );
  const { tone, label } = deviceStatusView(
    entry?.status ?? { phase: "stopped" },
  );

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => navigateTo(path)}
        aria-current={active ? "page" : undefined}
        title={label}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
          active ? "bg-accent text-foreground" : "text-muted-foreground",
        )}
      >
        <StatusDot tone={tone} />
        <span className="truncate text-[13px] font-medium text-foreground">
          {info.name}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {info.platform}
        </span>
      </button>
      <DeviceForest deviceId={info.deviceId} onOpen={() => navigateTo(path)} />
    </div>
  );
}

// One device's projects and worktrees, nested under its row. The
// queries are the same device-scoped builders the forest page uses
// (shared cache keys, silent errors), gated inside the options on the
// api being present -- an offline device fetches nothing and this
// renders whatever its last session cached, or nothing at all. Every
// row opens the device's forest page, where the real controls live.
function DeviceForest({
  deviceId,
  onOpen,
}: {
  deviceId: string;
  onOpen: () => void;
}) {
  const api = useRemoteDevices().find(
    (device) => device.deviceId === deviceId,
  )?.api;
  const { data: projects = [] } = useQuery(
    remoteProjectsQueryOptions(deviceId, api),
  );
  const worktreeQueries = useAllRemoteWorktrees(deviceId, api, projects);

  if (projects.length === 0) return null;
  return (
    <div className="flex flex-col pb-1">
      {projects.map((project, index) => (
        <ProjectGroup
          key={project.id}
          project={project}
          worktrees={worktreeQueries[index]?.data ?? []}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function ProjectGroup({
  project,
  worktrees,
  onOpen,
}: {
  project: Project;
  worktrees: Worktree[];
  onOpen: () => void;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 pl-4 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent"
      >
        <FolderGit2 className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{project.name}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">
          {worktrees.length}
        </span>
      </button>
      {worktrees.map((worktree) => (
        <WorktreeRow key={worktree.id} worktree={worktree} onOpen={onOpen} />
      ))}
    </div>
  );
}

function WorktreeRow({
  worktree,
  onOpen,
}: {
  worktree: Worktree;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 pl-8 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <span className="min-w-0 truncate">
        <BranchLabel branch={worktree.branch} detached={worktree.detached} />
      </span>
      {(worktree.ahead > 0 || worktree.behind > 0) && (
        <span className="tabular ml-auto shrink-0 text-[10px] text-muted-foreground/70">
          {worktree.ahead > 0 && `↑${worktree.ahead}`}
          {worktree.ahead > 0 && worktree.behind > 0 && " "}
          {worktree.behind > 0 && `↓${worktree.behind}`}
        </span>
      )}
    </button>
  );
}

// The desktop footer's app-level actions, in the web's vocabulary: the
// devices page, this browser's settings, and (signed in) sign out.
// Signed in implies enrolled implies configured, so the Clerk hook
// inside the sign-out button only mounts under a mounted provider.
function WebSidebarFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
      {signedIn && <SignOutIconButton />}
      <div className="flex-1" />
      {signedIn && (
        // Prefix match: a device's forest belongs to the same "your
        // machines" surface this button opens, as on the desktop.
        <NavIconButton
          to="/devices"
          tip="Devices"
          label="Devices"
          exact={false}
        >
          <MonitorSmartphone className="size-3.5" />
        </NavIconButton>
      )}
      <NavIconButton to="/settings" tip="Settings" label="Settings">
        <SettingsIcon className="size-3.5" />
      </NavIconButton>
    </div>
  );
}

function SignOutIconButton() {
  const signOut = useClerkSignOut();
  return (
    <SimpleTooltip tip="Sign out">
      <button
        type="button"
        aria-label="Sign out"
        disabled={signOut.isPending}
        onClick={() =>
          signOut.mutate(undefined, {
            // replace, not push: the status invalidation may already have
            // bounced the page to /login, and a pushed second /login
            // entry would trap the Back button.
            onSuccess: () => redirectTo(webPaths.login),
          })
        }
        className={cn(SIDEBAR_ICON_BUTTON, "disabled:opacity-50")}
      >
        <LogOut className="size-3.5" />
      </button>
    </SimpleTooltip>
  );
}
