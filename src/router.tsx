import { useEffect, useRef, useState } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { useIsFetching } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ConfigureProject } from "@/components/detail/ConfigureProject";
import { EmptyState } from "@/components/detail/EmptyState";
import { ManageBranches } from "@/components/detail/ManageBranches";
import { NewWorktree } from "@/components/detail/NewWorktree";
import { Settings } from "@/components/detail/Settings";
import { WorktreeDetail } from "@/components/detail/WorktreeDetail";

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
          style={{ ["-webkit-app-region" as never]: "drag" }}
        />
        <ActivityIndicator />
        <Outlet />
      </main>
    </div>
  );
}

// Show the spinner immediately on fetching, then linger briefly after the
// last fetch settles. Local git calls finish in tens of ms, so without the
// linger you'd never perceive the flash.
const SPINNER_LINGER_MS = 100;

function ActivityIndicator() {
  // Queries with `meta: { silentSpinner: true }` (e.g. branches, which
  // shows its own popup spinner) don't count toward the global indicator.
  const fetching = useIsFetching({
    predicate: (q) => !q.meta?.silentSpinner,
  });
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fetching > 0) {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setVisible(true);
      return;
    }
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      hideTimer.current = null;
    }, SPINNER_LINGER_MS);
    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [fetching]);

  return (
    <div
      aria-hidden={!visible}
      aria-label={visible ? "Syncing with git" : undefined}
      className={cn(
        // Mirror the page header's pt-7 px-6 so the spinner top/right
        // aligns with the breadcrumb's top/left.
        "pointer-events-none absolute top-7 right-6 z-40 text-muted-foreground",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <Loader2 className="size-3.5 animate-spin" />
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

// Force remount on params change so refetchOnMount: "always" fires
// (TanStack Router keeps the same instance and just re-renders otherwise).
function KeyedWorktreeDetail() {
  const { projectId, worktreeName } = worktreeRoute.useParams();
  return <WorktreeDetail key={`${projectId}:${worktreeName}`} />;
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

const worktreeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeName",
  component: KeyedWorktreeDetail,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  settingsRoute,
  newWorktreeRoute,
  configureProjectRoute,
  manageBranchesRoute,
  worktreeRoute,
]);

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export {
  configureProjectRoute,
  manageBranchesRoute,
  newWorktreeRoute,
  settingsRoute,
  worktreeRoute,
};
