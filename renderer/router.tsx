// The one route tree, served by both shells. The desktop mounts it on
// a memory history, the browser on real history (deep links must
// survive a reload, which is also why the web deploy rewrites every
// path to index.html). A hostless client only ever reaches the
// device-scoped twins: it has no local project for the /projects tree
// to show. Registering the router type once here is what lets every
// typed Link and navigate in the shared components check against the
// same tree whichever shell mounts them.
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
  useRouter,
} from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { ErrorFallback } from "@/components/ErrorFallback";
import { EmptyState } from "@/components/EmptyState";
import { ForestPage } from "@/components/ForestPage";
import { NotFoundPage } from "@/components/NotFoundPage";
import { Settings } from "@/components/settings/Settings";
import { DevicesPage } from "@/components/remote/DevicesPage";
import { withRemoteScope } from "@/components/remote/RemoteScope";
import { CommitDiff } from "@/components/diff/CommitDiff";
import { PullRequestDiff } from "@/components/diff/PullRequestDiff";
import { WorktreeDetail } from "@/components/worktreeDetail/WorktreeDetail";
import { WorktreeDiff } from "@/components/diff/WorktreeDiff";
import { isPhoneLayout } from "@/hooks/ui/useViewport";
import { hasLocalHost } from "@/lib/localHost";
import { PROJECT_ROUTE_PATHS, WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});

// "/" is where a fresh window opens and where leaving a worktree's
// pages lands. With projects of its own the app resolves it to the
// first worktree (or the first-run state). A hostless client has no
// local forest, so its home is the account's devices (on a phone, the
// inbox tab), redirected at load time (no frame rendered) and replaced
// in history so Back never lands on the dispatcher again.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    if (!hasLocalHost) {
      throw redirect({
        to: isPhoneLayout() ? "/forest/$view" : "/devices",
        params: { view: "inbox" },
        replace: true,
      });
    }
  },
  component: EmptyState,
});

// The phone layout's two forest tabs, the inbox and the project tree,
// as one route with the view as its param (see ForestPage). One route
// rather than two so a tab flip re-renders the same page instance and
// keeps its query graph, where a second route would remount it and
// re-list every peer. Off the root like settings. A wide viewport has
// the forest in its sidebar, so the page only points at it.
const forestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forest/$view",
  component: ForestPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: Settings,
});

// The pages below are lazy: a session that never opens one (a project
// page, the tidy page) does not download it at boot.

// App-wide, like settings: the tidy page spans every project rather than
// scoping to one, so it hangs off the root instead of /projects.
const tidyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tidy",
  component: lazyRouteComponent(
    () => import("@/components/tidy/TidyForest"),
    "TidyForest",
  ),
});

// App-wide like settings: the account and its device registry span
// machines rather than describing this one, so they get their own page
// off the root.
const devicesIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
  component: DevicesPage,
});

// The console brings xterm along (a few hundred KB), which a session
// that never opens a console has no use for at window open. One lazy
// component for both trees, so the chunk loads once.
const scriptConsoleComponent = lazyRouteComponent(
  () => import("@/components/scriptConsole/ScriptConsole"),
  "ScriptConsole",
);

// Device-scoped twins of the worktree pages (v2: remote feels local).
// The SAME components serve both trees: withRemoteScope resolves the
// device, mounts HostScopeProvider and the push-refresh watcher, and
// the pages read their params non-strictly. Local-only affordances
// inside them gate on useWorktreeNav().remote.
const remoteWorktreeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.detail.remote,
  component: withRemoteScope(WorktreeDetail),
  remountDeps: ({ params }) => params,
});

const remoteWorktreeDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.diff.remote,
  component: withRemoteScope(WorktreeDiff),
});

const remotePullRequestDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.prDiff.remote,
  component: withRemoteScope(PullRequestDiff),
});

const remoteCommitDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.commit.remote,
  component: withRemoteScope(CommitDiff),
});

const remoteScriptConsoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.script.remote,
  component: withRemoteScope(scriptConsoleComponent),
});

// remountDeps on the project- and worktree-scoped routes: the router
// keeps one component instance across a params change and just
// re-renders it, so without this a route would keep showing the
// previous entity's data until its queries happened to refetch. The
// router keys the match on this value, which is what the hand-written
// `key={projectId}` wrappers used to do.

// The project pages, each lazy once for both trees so the chunk loads
// once, and each mounted twice: under /projects for this machine's
// projects, under /devices/$deviceId for a peer's (withRemoteScope,
// exactly like the worktree pages). A remote project header offers
// the same actions a local one does, and they all land here.
function projectRoutePair(
  page: keyof typeof PROJECT_ROUTE_PATHS,
  component: ReturnType<typeof lazyRouteComponent>,
) {
  const paths = PROJECT_ROUTE_PATHS[page];
  return [
    createRoute({
      getParentRoute: () => rootRoute,
      path: paths.local,
      component,
      remountDeps: ({ params }) => params,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: paths.remote,
      component: withRemoteScope(component),
      remountDeps: ({ params }) => params,
    }),
  ];
}

const projectRoutes = [
  ...projectRoutePair(
    "new",
    lazyRouteComponent(
      () => import("@/components/newWorktree/NewWorktree"),
      "NewWorktree",
    ),
  ),
  ...projectRoutePair(
    "configure",
    lazyRouteComponent(
      () => import("@/components/configure/ConfigureProject"),
      "ConfigureProject",
    ),
  ),
  ...projectRoutePair(
    "branches",
    lazyRouteComponent(
      () => import("@/components/manageBranches/ManageBranches"),
      "ManageBranches",
    ),
  ),
  ...projectRoutePair(
    "convertExternal",
    lazyRouteComponent(
      () => import("@/components/convertExternal/ConvertExternalWorktrees"),
      "ConvertExternalWorktrees",
    ),
  ),
  ...projectRoutePair(
    "worktreeLocation",
    lazyRouteComponent(
      () => import("@/components/worktreeLocation/WorktreeLocation"),
      "WorktreeLocation",
    ),
  ),
];

const worktreeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.detail.local,
  component: WorktreeDetail,
  remountDeps: ({ params }) => params,
});

const scriptConsoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.script.local,
  component: scriptConsoleComponent,
});

const worktreeDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.diff.local,
  component: WorktreeDiff,
});

const pullRequestDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.prDiff.local,
  component: PullRequestDiff,
});

const commitDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.commit.local,
  component: CommitDiff,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  forestRoute,
  settingsRoute,
  tidyRoute,
  devicesIndexRoute,
  remoteWorktreeRoute,
  remoteWorktreeDiffRoute,
  remotePullRequestDiffRoute,
  remoteCommitDiffRoute,
  remoteScriptConsoleRoute,
  ...projectRoutes,
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

// The shell's one choice: which history the tree rides.
export function createAppRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    defaultPreload: false,
    defaultErrorComponent: RouteErrorFallback,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
