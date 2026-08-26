// Path vocabulary and imperative navigation for the web shell. The
// desktop router registers its route tree globally (the tanstack
// Register interface in renderer/router.tsx), so the web router cannot
// register a second one, and typed Link/useNavigate helpers would check
// against the WRONG tree. Web navigation therefore goes through the
// router's history with the paths named here, and router.tsx installs
// the history impl, which also keeps pages free of an import cycle
// with the route tree.

export const webPaths = {
  index: "/",
  login: "/login",
  authCallback: "/auth/callback",
  devices: "/devices",
  appearance: "/appearance",
  deviceForest: (deviceId: string) =>
    `/devices/${encodeURIComponent(deviceId)}`,
} as const;

type NavigateImpl = {
  push(path: string): void;
  replace(path: string): void;
};

let impl: NavigateImpl = { push: () => {}, replace: () => {} };

export function installNavigate(fn: NavigateImpl): void {
  impl = fn;
}

export function navigateTo(path: string): void {
  impl.push(path);
}

// Replace-style hop for redirects and flow completions, so the entry
// being left (a dispatch-only route, or the OAuth callback URL still
// carrying its spent code) does not stay reachable via Back.
export function redirectTo(path: string): void {
  impl.replace(path);
}
