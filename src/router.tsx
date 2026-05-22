import { useState } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import { ErrorFallback } from "@/components/ErrorFallback";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ConfigureProject } from "@/components/detail/ConfigureProject";
import { ConvertExternalWorktrees } from "@/components/detail/ConvertExternalWorktrees";
import { WorktreeLocation } from "@/components/detail/WorktreeLocation";
import { EmptyState } from "@/components/detail/EmptyState";
import { ManageBranches } from "@/components/detail/ManageBranches";
import { NewWorktree } from "@/components/detail/NewWorktree";
import { ScriptConsole } from "@/components/detail/ScriptConsole";
import { Settings } from "@/components/detail/Settings";
import { CommitDiff } from "@/components/detail/CommitDiff";
import { WorktreeDetail } from "@/components/detail/WorktreeDetail";
import { WorktreeDiff } from "@/components/detail/WorktreeDiff";
import { dragRegion } from "@/lib/utils";

const SIDEBAR_KEY = "sidebar.width";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 240;

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_KEY);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT;
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function RootLayout() {
  const [sidebarWidth, setSidebarWidth] = useState<number>(readStoredWidth);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let last = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      last = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX));
      setSidebarWidth(last);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        window.localStorage.setItem(SIDEBAR_KEY, String(Math.round(last)));
      } catch {
        // localStorage may be unavailable; not fatal.
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <div style={{ width: sidebarWidth }} className="shrink-0">
        <Sidebar />
      </div>
      <div
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={-1}
        className="relative w-px shrink-0 cursor-col-resize bg-border"
      >
        <div className="absolute inset-y-0 -left-1 w-2" />
      </div>
      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 z-30 h-7"
          style={dragRegion("drag")}
        />
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: EmptyState,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: Settings,
});

const newWorktreeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/new",
  component: KeyedNewWorktree,
});

const configureProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/configure",
  component: KeyedConfigureProject,
});

const manageBranchesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/branches",
  component: KeyedManageBranches,
});

const convertExternalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/convert-external",
  component: KeyedConvertExternal,
});

const worktreeLocationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktree-location",
  component: KeyedWorktreeLocation,
});

// Force remount on params change so refetchOnMount: "always" fires
// (TanStack Router keeps the same instance and just re-renders otherwise).
function KeyedWorktreeDetail() {
  const { projectId, worktreeId } = worktreeRoute.useParams();
  return <WorktreeDetail key={`${projectId}:${worktreeId}`} />;
}

function KeyedNewWorktree() {
  const { projectId } = newWorktreeRoute.useParams();
  return <NewWorktree key={projectId} />;
}

function KeyedConfigureProject() {
  const { projectId } = configureProjectRoute.useParams();
  return <ConfigureProject key={projectId} />;
}

function KeyedManageBranches() {
  const { projectId } = manageBranchesRoute.useParams();
  return <ManageBranches key={projectId} />;
}

function KeyedConvertExternal() {
  const { projectId } = convertExternalRoute.useParams();
  return <ConvertExternalWorktrees key={projectId} />;
}

function KeyedWorktreeLocation() {
  const { projectId } = worktreeLocationRoute.useParams();
  return <WorktreeLocation key={projectId} />;
}

const worktreeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeId",
  component: KeyedWorktreeDetail,
});

const scriptConsoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
  component: ScriptConsole,
});

const worktreeDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeId/diff",
  component: WorktreeDiff,
});

const commitDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeId/commits/$hash",
  component: CommitDiff,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  settingsRoute,
  newWorktreeRoute,
  configureProjectRoute,
  manageBranchesRoute,
  convertExternalRoute,
  worktreeLocationRoute,
  worktreeRoute,
  scriptConsoleRoute,
  worktreeDiffRoute,
  commitDiffRoute,
]);

function RouteErrorFallback({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const router = useRouter();
  const retry = () => {
    reset();
    void router.invalidate();
  };
  return (
    <ErrorFallback
      error={error}
      scope="view"
      action={{ label: "Try again", onClick: retry }}
    />
  );
}

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
  defaultPreload: false,
  defaultErrorComponent: RouteErrorFallback,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export {
  commitDiffRoute,
  configureProjectRoute,
  convertExternalRoute,
  manageBranchesRoute,
  newWorktreeRoute,
  scriptConsoleRoute,
  settingsRoute,
  worktreeDiffRoute,
  worktreeLocationRoute,
  worktreeRoute,
};
