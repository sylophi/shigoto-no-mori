// The web client's router: real browser history (deep links must
// survive a reload, which is also why the deploy config rewrites every
// path to index.html). The desktop router owns the global tanstack
// Register (renderer/router.tsx), so this tree deliberately does not
// register itself; navigation goes through nav.ts's history-backed
// helper instead of the Register-typed hooks. Every path here is a
// subset of the desktop tree, so reused desktop components whose typed
// navigate calls name these paths mount unmodified.
//
// The device forest route reuses the desktop's RemoteForest under the
// SAME route id ("/devices/$deviceId"): its getRouteApi lookup is keyed
// by that id at runtime, so the component mounts here unmodified.
import { useEffect } from "react";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { ErrorFallback } from "@/components/ErrorFallback";
import { RemoteForest } from "@/components/remote/RemoteForest";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { DevicesPage } from "./DevicesPage";
import { LoginPage } from "./LoginPage";
import { NotFoundPage } from "./NotFoundPage";
import { SettingsPage } from "./SettingsPage";
import { WebShell } from "./WebShell";
import { installNavigate, redirectTo, webPaths } from "./nav";

// The root path only dispatches: devices when signed in, login
// otherwise. Rendered blank for the single frame the status read
// takes, and replaced in history so Back never lands on the
// dispatcher again.
function IndexRedirect() {
  const { data: status, isPending } = useAccountStatus();
  useEffect(() => {
    if (isPending) return;
    redirectTo(status?.signedIn === true ? webPaths.devices : webPaths.login);
  }, [isPending, status?.signedIn]);
  return null;
}

const rootRoute = createRootRoute({
  component: WebShell,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: webPaths.index,
  component: IndexRedirect,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: webPaths.login,
  component: LoginPage,
});

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: webPaths.devices,
  component: DevicesPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: webPaths.settings,
  component: SettingsPage,
});

// Same id and remount behavior as the desktop's device route, so
// RemoteForest's route api resolves and switching devices swaps the
// data instead of showing the previous device's forest.
const deviceForestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices/$deviceId",
  component: RemoteForest,
  remountDeps: ({ params }) => params,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  devicesRoute,
  settingsRoute,
  deviceForestRoute,
]);

function RouteErrorFallback({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <ErrorFallback
      error={error}
      scope="view"
      action={{ label: "Try again", onClick: reset }}
    />
  );
}

export const webRouter = createRouter({
  routeTree,
  history: createBrowserHistory(),
  defaultPreload: false,
  defaultErrorComponent: RouteErrorFallback,
});

// nav.ts's history-backed navigation, installed here so pages never
// import the route tree and the router never depends on a page.
installNavigate({
  push: (path) => webRouter.history.push(path),
  replace: (path) => webRouter.history.replace(path),
});
