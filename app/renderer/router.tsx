// The one route tree, served by both shells. The desktop mounts it on
// a memory history, the browser on real history (deep links must
// survive a reload, which is also why the web deploy rewrites every
// path to index.html). A hostless client only ever reaches its peers'
// device pages: it has no projects of its own. Registering the router
// type once here is what lets every typed Link and navigate in the
// shared components check against the same tree whichever shell
// mounts them.
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
import { withDeviceScope } from "@/components/remote/RemoteScope";
import { WorktreeDetail } from "@/components/worktreeDetail/WorktreeDetail";
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
// scoping to one, so it hangs off the root instead of a device's.
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
// that never opens a console has no use for at window open.
const ScriptConsole = lazyRouteComponent(
  () => import("@/components/scriptConsole/ScriptConsole"),
  "ScriptConsole",
);

// The three diff pages bring the diff renderer and the syntax
// highlighter along, over a quarter of what boot would otherwise
// download, and a session starts on a forest or a worktree, never on a
// diff. Lazy like the console.
const WorktreeDiff = lazyRouteComponent(
  () => import("@/components/diff/WorktreeDiff"),
  "WorktreeDiff",
);
const PullRequestDiff = lazyRouteComponent(
  () => import("@/components/diff/PullRequestDiff"),
  "PullRequestDiff",
);
const CommitDiff = lazyRouteComponent(
  () => import("@/components/diff/CommitDiff"),
  "CommitDiff",
);

// The files page shows code through the same highlighter the diffs
// use, so it is lazy for the same reason.
const WorktreeFiles = lazyRouteComponent(
  () => import("@/components/files/WorktreeFiles"),
  "WorktreeFiles",
);

// `path` is the file the files page shows. Shared by both trees like
// the diff search.
function validateFilesSearch(search: Record<string, unknown>): {
  path?: string;
} {
  const path = search["path"];
  return typeof path === "string" && path.length > 0 ? { path } : {};
}

// `amend` opens the changes page already set to rewrite the last
// commit (a commit row's "Amend" lands here).
function validateDiffSearch(search: Record<string, unknown>): { amend?: true } {
  return search["amend"] === true ? { amend: true } : {};
}

// The device pages: every worktree and project page, for this machine
// and every peer alike, under /devices/$deviceId. withDeviceScope
// resolves the device (this machine's id to window.api, a peer's to its
// session) and scopes the page to it, so the page itself never knows
// which it is showing (v2: remote feels local). Local-only affordances
// inside them gate on useHostScope().remote.
//
// remountDeps on the detail and project pages: the router keeps one
// component instance across a params change and just re-renders it, so
// without this a route would keep showing the previous entity's data
// until its queries happened to refetch. The router keys the match on
// this value, which is what the hand-written `key={projectId}` wrappers
// used to do.
const worktreeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.detail,
  component: withDeviceScope(WorktreeDetail),
  remountDeps: ({ params }) => params,
});

const worktreeDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.diff,
  component: withDeviceScope(WorktreeDiff),
  validateSearch: validateDiffSearch,
});

const pullRequestDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.prDiff,
  component: withDeviceScope(PullRequestDiff),
});

const commitDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.commit,
  component: withDeviceScope(CommitDiff),
});

// Params only: a new worktree is a fresh page (its folders), a new
// pick within one is not.
const worktreeFilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.files,
  component: withDeviceScope(WorktreeFiles),
  validateSearch: validateFilesSearch,
  remountDeps: ({ params }) => params,
});

const scriptConsoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.script,
  component: withDeviceScope(ScriptConsole),
});

// The project pages, each lazy. A peer's project header offers the
// same actions this machine's does, and they all land here.
function projectRoute(
  page: keyof typeof PROJECT_ROUTE_PATHS,
  component: ReturnType<typeof lazyRouteComponent>,
) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path: PROJECT_ROUTE_PATHS[page],
    component: withDeviceScope(component),
    remountDeps: ({ params }) => params,
  });
}

const projectRoutes = [
  projectRoute(
    "new",
    lazyRouteComponent(
      () => import("@/components/newWorktree/NewWorktree"),
      "NewWorktree",
    ),
  ),
  projectRoute(
    "configure",
    lazyRouteComponent(
      () => import("@/components/configure/ConfigureProject"),
      "ConfigureProject",
    ),
  ),
  projectRoute(
    "branches",
    lazyRouteComponent(
      () => import("@/components/manageBranches/ManageBranches"),
      "ManageBranches",
    ),
  ),
  projectRoute(
    "convertExternal",
    lazyRouteComponent(
      () => import("@/components/convertExternal/ConvertExternalWorktrees"),
      "ConvertExternalWorktrees",
    ),
  ),
  projectRoute(
    "worktreeLocation",
    lazyRouteComponent(
      () => import("@/components/worktreeLocation/WorktreeLocation"),
      "WorktreeLocation",
    ),
  ),
];

const routeTree = rootRoute.addChildren([
  indexRoute,
  forestRoute,
  settingsRoute,
  tidyRoute,
  devicesIndexRoute,
  worktreeRoute,
  worktreeDiffRoute,
  pullRequestDiffRoute,
  commitDiffRoute,
  worktreeFilesRoute,
  scriptConsoleRoute,
  ...projectRoutes,
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
