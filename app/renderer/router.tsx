// The one route tree, served by both shells. The desktop mounts it on
// a memory history, the browser on real history (deep links must
// survive a reload, which is also why the web deploy rewrites every
// path to index.html). A hostless client only ever reaches its peers'
// device pages: it has no projects of its own. Registering the router
// type once here is what lets every typed Link and navigate in the
// shared components check against the same tree whichever shell
// mounts them.
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
  useRouter,
} from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { ErrorFallbackView } from "@shigomori/ui/views/ErrorFallbackView.tsx";
import { EmptyState } from "@/components/EmptyState";
import { ForestPage } from "@/components/ForestPage";
import { MigrationPage } from "@/components/migration/MigrationPage";
import { WelcomePage } from "@/components/welcome/WelcomePage";
import { NotFoundPage } from "@/components/NotFoundPage";
import { Settings } from "@/components/settings/Settings";
import { SettingsPages } from "@/components/settings/SettingsSidebarNav";
import { DevicesPage } from "@/components/remote/DevicesPage";
import { withDeviceScope } from "@/components/remote/RemoteScope";
import { WorktreeDetail } from "@/components/worktreeDetail/WorktreeDetail";
import { isPhoneLayout } from "@/hooks/ui/useViewport";
import { hasLocalHost } from "@/lib/localHost";
import {
  DEVICE_TERMINALS_PATH,
  MIGRATION_PATH,
  PROJECT_ROUTE_PATHS,
  WELCOME_PATH,
  WORKTREE_ROUTE_PATHS,
} from "@/lib/routePaths";

// The window the router serves: its theme root, which the phone
// layout is measured on.
interface WindowContext {
  root: HTMLElement;
}

const rootRoute = createRootRouteWithContext<WindowContext>()({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});

// "/" is where a fresh window opens and where leaving a worktree's
// pages lands. With projects of its own the app waits there for a pick
// from the sidebar (or shows the first-run state). A hostless
// client has no local forest, so its home is the account's devices (on
// a phone, the inbox tab), redirected at load time (no frame rendered)
// and replaced in history so Back never lands on the dispatcher again.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    if (!hasLocalHost) {
      throw redirect({
        to: isPhoneLayout(context.root) ? "/forest/$view" : "/account",
        params: { view: "inbox" },
        replace: true,
      });
    }
  },
  component: EmptyState,
});

// The v3 migration, which a window shows in place of the app while it
// runs: no sidebar, no palette (AppShell).
const migrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: MIGRATION_PATH,
  component: MigrationPage,
});

// A fresh install's first run, in place of the app like the migration.
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WELCOME_PATH,
  component: WelcomePage,
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

// Settings and the pages its list leads to share that list (see
// SettingsPages).
const settingsPagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "settings-pages",
  component: SettingsPages,
});

const settingsRoute = createRoute({
  getParentRoute: () => settingsPagesRoute,
  path: "/settings",
  component: Settings,
});

// The pages below are lazy: a session that never opens one (a project
// page, the tidy page) does not download it at boot.

// App-wide, like settings: the tidy page spans every project rather than
// scoping to one, so it sits beside settings instead of under a device.
const tidyRoute = createRoute({
  getParentRoute: () => settingsPagesRoute,
  path: "/tidy",
  component: lazyRouteComponent(
    () => import("@/components/tidy/TidyForest"),
    "TidyForest",
  ),
});

// App-wide like the forest page: what runs on every device, off the
// root so the sidebar keeps the forest beside it.
const liveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/live",
  component: lazyRouteComponent(
    () => import("@/components/live/LivePage"),
    "LivePage",
  ),
});

// App-wide like settings: the account and its device registry span
// machines rather than describing this one, so they get their own page
// beside it, sharing its list. A hostless client's account page is its
// home rather than a section of Settings, so there it hangs off the
// root and the sidebar keeps the peers' forest.
const accountRoute = createRoute({
  getParentRoute: () => (hasLocalHost ? settingsPagesRoute : rootRoute),
  path: "/account",
  component: DevicesPage,
});

// The account page's old path, still in links and bookmarks from
// before it moved (a hostless client's home was here).
const devicesRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/account",
      search: location.search,
      hash: location.hash,
      replace: true,
    });
  },
});

// The diff pages bring the diff renderer and the syntax
// highlighter along, over a quarter of what boot would otherwise
// download, and a session starts on a forest or a worktree, never on a
// diff.
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
const BranchDiff = lazyRouteComponent(
  () => import("@/components/diff/BranchDiff"),
  "BranchDiff",
);
const StashDiff = lazyRouteComponent(
  () => import("@/components/diff/StashDiff"),
  "StashDiff",
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

const branchDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.branchDiff,
  component: withDeviceScope(BranchDiff),
});

const stashesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.stashes,
  component: withDeviceScope(StashDiff),
});

const stashDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: WORKTREE_ROUTE_PATHS.stash,
  component: withDeviceScope(StashDiff),
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

// A device's own terminals, lazy like the console for xterm. The pick
// rides the search, so a reload or a link lands on the same tab.
const deviceTerminalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: DEVICE_TERMINALS_PATH,
  component: withDeviceScope(
    lazyRouteComponent(
      () => import("@/components/terminal/DeviceTerminals"),
      "DeviceTerminals",
    ),
  ),
  validateSearch: (search: Record<string, unknown>): { terminal?: string } =>
    typeof search["terminal"] === "string"
      ? { terminal: search["terminal"] }
      : {},
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
  migrationRoute,
  welcomeRoute,
  forestRoute,
  liveRoute,
  // Where accountRoute hangs, as its getParentRoute says.
  ...(hasLocalHost
    ? [settingsPagesRoute.addChildren([settingsRoute, tidyRoute, accountRoute])]
    : [
        settingsPagesRoute.addChildren([settingsRoute, tidyRoute]),
        accountRoute,
      ]),
  devicesRedirectRoute,
  deviceTerminalsRoute,
  worktreeRoute,
  worktreeDiffRoute,
  pullRequestDiffRoute,
  branchDiffRoute,
  stashesRoute,
  stashDiffRoute,
  commitDiffRoute,
  worktreeFilesRoute,
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
    <ErrorFallbackView
      error={error}
      scope="view"
      action={{ label: "Try again", onClick: retry }}
    />
  );
}

// The shell's one choice: which history the tree rides.
export function createAppRouter(history: RouterHistory, root: HTMLElement) {
  return createRouter({
    routeTree,
    history,
    context: { root },
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
