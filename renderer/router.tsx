import { useState } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { ErrorFallback } from "@/components/ErrorFallback";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ConfigureProject } from "@/components/configure/ConfigureProject";
import { ConvertExternalWorktrees } from "@/components/convertExternal/ConvertExternalWorktrees";
import { WorktreeLocation } from "@/components/worktreeLocation/WorktreeLocation";
import { EmptyState } from "@/components/EmptyState";
import { ManageBranches } from "@/components/manageBranches/ManageBranches";
import { NewWorktree } from "@/components/newWorktree/NewWorktree";
import { Settings } from "@/components/settings/Settings";
import { TidyForest } from "@/components/tidy/TidyForest";
import { CommitDiff } from "@/components/diff/CommitDiff";
import { PullRequestDiff } from "@/components/diff/PullRequestDiff";
import { WorktreeDetail } from "@/components/worktreeDetail/WorktreeDetail";
import { WorktreeDiff } from "@/components/diff/WorktreeDiff";
import { dragRegion } from "@/lib/utils";
import { readStored, writeStored } from "@/lib/localStorage";

const SIDEBAR_KEY = "sidebar.width";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 240;

function readStoredWidth(): number {
  const raw = readStored(SIDEBAR_KEY);
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
}

function RootLayout() {
  const [sidebarWidth, setSidebarWidth] = useState<number>(readStoredWidth);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    Object.assign(document.body.style, {
      cursor: "col-resize",
      userSelect: "none",
    });
    let last = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      last = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX));
      setSidebarWidth(last);
    };
    const onUp = () => {
      Object.assign(document.body.style, {
        cursor: "",
        userSelect: "",
      });
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      writeStored(SIDEBAR_KEY, String(Math.round(last)));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex h-dvh overflow-hidden text-foreground">
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
      <main
        data-doubutsu-zone="main"
        className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
      >
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

// App-wide, like settings: the tidy page spans every project rather than
// scoping to one, so it hangs off the root instead of /projects.
const tidyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tidy",
  component: TidyForest,
});

// remountDeps on the project- and worktree-scoped routes: the router
// keeps one component instance across a params change and just
// re-renders it, so without this a route would keep showing the
// previous entity's data until its queries happened to refetch. The
// router keys the match on this value, which is what the hand-written
// `key={projectId}` wrappers used to do.
const newWorktreeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/new",
  component: NewWorktree,
  remountDeps: ({ params }) => params,
});

const configureProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/configure",
  component: ConfigureProject,
  remountDeps: ({ params }) => params,
});

const manageBranchesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/branches",
  component: ManageBranches,
  remountDeps: ({ params }) => params,
});

const convertExternalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/convert-external",
  component: ConvertExternalWorktrees,
  remountDeps: ({ params }) => params,
});

const worktreeLocationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktree-location",
  component: WorktreeLocation,
  remountDeps: ({ params }) => params,
});

const worktreeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeId",
  component: WorktreeDetail,
  remountDeps: ({ params }) => params,
});

const scriptConsoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
  // The console brings xterm along (a few hundred KB), which a session
  // that never opens a console has no use for at window open.
  component: lazyRouteComponent(
    () => import("@/components/scriptConsole/ScriptConsole"),
    "ScriptConsole",
  ),
});

const worktreeDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeId/diff",
  component: WorktreeDiff,
});

const pullRequestDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeId/pr-diff",
  component: PullRequestDiff,
});

const commitDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$worktreeId/commits/$hash",
  component: CommitDiff,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  settingsRoute,
  tidyRoute,
  newWorktreeRoute,
  configureProjectRoute,
  manageBranchesRoute,
  convertExternalRoute,
  worktreeLocationRoute,
  worktreeRoute,
  scriptConsoleRoute,
  worktreeDiffRoute,
  pullRequestDiffRoute,
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
