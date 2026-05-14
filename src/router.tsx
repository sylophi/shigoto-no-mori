import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ConfigureProject } from "@/components/detail/ConfigureProject";
import { EmptyState } from "@/components/detail/EmptyState";
import { NewWorktree } from "@/components/detail/NewWorktree";
import { Settings } from "@/components/detail/Settings";
import { WorktreeDetail } from "@/components/detail/WorktreeDetail";

function RootLayout() {
  return (
    <div className="grid h-dvh grid-cols-[280px_1fr] overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="relative flex h-full flex-col overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 z-30 h-7"
          style={{ ["-webkit-app-region" as never]: "drag" }}
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
  component: NewWorktree,
});

const configureProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/configure",
  component: ConfigureProject,
});

const worktreeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/worktrees/$branch",
  component: WorktreeDetail,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  settingsRoute,
  newWorktreeRoute,
  configureProjectRoute,
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
  newWorktreeRoute,
  settingsRoute,
  worktreeRoute,
};
