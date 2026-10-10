# The app

The Electron desktop app and the web client, one package of the
root pnpm workspace. Paths here are relative to this directory. The
terminal `sm` (`packages/cli`) and the mirroring engine (`file-sync/`)
it bundles, and the device hub (`hub/`) it talks to, are siblings one
level up.

- `DESIGN.md`: rules for the visual layer.
- `lab/README.md`: testing by hand on the real UI, driven with weblab:
  the fake host (any screen posed in a browser) and device windows
  (the real app as several devices on one machine).
- `test/README.md`: the programmatic checks, the proofs `pnpm test`
  and lefthook run.

## Layout

One UI, two shells. The desktop window and the browser tab render the
same `renderer/` tree over the same `window.api` surface. What differs
is the binding underneath, and the two bindings are parallel:

| Concern | Desktop (Electron) | Web (browser) |
| --- | --- | --- |
| Composition root: handlers on the wires, the direct plane, `window.api` | `host/process/` (the host) + `main/ipc/register.ts` (the shell) + `main/preload.ts` + `renderer/lib/runtime/` | `web/ipc/register.ts` + `web/preload.ts` |
| Transport under `window.api` | `shared/ipc/shell.ts` (the shell, over a port) + `shared/remote/hostLink.ts` (the host, over the loopback) | `web/ipc/localRegistrar.ts` (the tab's own modules) + the direct plane (every host, a peer) |
| Account: credential store, enroll, device name | `main/core/account/` | `web/account/` |
| Device hub socket | `host/hub/connection.ts` (node) | `web/hub/connection.ts` (browser) |
| Page entry | `index.html` → `renderer/index.tsx` | `web/index.html` → `web/main.tsx` → `web/boot.tsx` |

`host/` is what a binding serves: the projects, worktrees, scripts and
git of the machine it runs on. It is not the engine for them: the data
model (the project list, worktree rows and identities, their marks,
config, the launcher row, package scripts) belongs to the engine
(`../packages/engine`), which the host runs in-process
(`host/lib/engine.ts`, `host/lib/engineOps.ts`) on the same store
as the terminal `sm`, so the app and a terminal never disagree. What
`host/lib` keeps is what lives in the host's process (running scripts,
mirror sessions, the device link) and the plain git the engine has no
service for (diffs, commits, pulls). The browser binding serves none of it (a
tab hosts nothing), so the web client is the desktop with no local
projects: a hostless controller for the account's other devices. The
renderer gates the few surfaces that only make sense with a machine of
its own behind the window (launch tools, this device's settings, port
forwarding) on `renderer/lib/localHost.ts`; everything else is the same
code in both shells. `shared/` is the code every side compiles, over
the contracts in `packages/contracts`.

The desktop app is as many windows as the user opens, each one client
of the host like a browser tab: its own runtime, links and
subscriptions, its own page and terminal drawer. The shell keeps the
set (`main/electron/windows.ts`): New Window, a page opened in a
window of its own, deep links to the window focused last, and each
window's page and bounds brought back at the next start. The app quits
with its last window.
