// Path vocabulary and imperative navigation for the web shell. The
// desktop router registers its route tree globally (the tanstack
// Register interface in renderer/router.tsx), so the web router cannot
// register a second one, and typed Link/useNavigate helpers would check
// against the WRONG tree. Web navigation therefore goes through the
// router's history with the paths named here, and router.tsx installs
// the history impl, which also keeps pages free of an import cycle
// with the route tree.

// Settings deliberately shares the desktop's "/settings" path (not a
// web-only name): every web path being a subset of the desktop tree is
// what lets reused desktop components (NavIconButton, the sidebar's
// remote worktree rows) pass the Register-typed navigate checks
// unmodified.
export const webPaths = {
  index: "/",
  login: "/login",
  devices: "/devices",
  settings: "/settings",
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
// being left (a dispatch-only route) does not stay reachable via Back.
export function redirectTo(path: string): void {
  impl.replace(path);
}
