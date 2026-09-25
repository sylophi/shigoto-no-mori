# The app

The Electron desktop app and the web client, one pnpm project. Paths
here are relative to this directory. The `sm` CLI (`cli/`) and the
mirroring engine (`file-sync/`) it bundles, and the device hub
(`hub/`) it talks to, are siblings one level up.

- `DESIGN.md`: rules for the visual layer.
- `MANUAL-TESTING.md`: running the app, driving it from a script,
  testing remote flows on one machine.
- `lab/README.md`: the UI lab, the renderer posed in a browser.

## Layout

One UI, two shells. The desktop window and the browser tab render the
same `renderer/` tree over the same `window.api` surface. What differs
is the binding underneath, and the two bindings are parallel:

| Concern | Desktop (Electron) | Web (browser) |
| --- | --- | --- |
| Composition root: handlers on the wires, the direct plane, `window.api` | `main/ipc/register.ts` + `main/preload.ts` | `web/ipc/register.ts` + `web/preload.ts` |
| Transport under `window.api` | `main/preloadTransport.ts` (IPC) | `web/ipc/loopback.ts` (in-page) |
| Account: credential store, enroll, device name | `main/core/account/` | `web/account/` |
| Device hub socket | `host/hub/connection.ts` (node) | `web/hub/connection.ts` (browser) |
| Page entry | `index.html` → `renderer/index.tsx` | `web/index.html` → `web/main.tsx` → `web/boot.tsx` |

`host/` is what a binding serves: the projects, worktrees, scripts and
git of the machine it runs on. It is not the engine for them: the data
model (the project list, worktree rows and identities, their marks,
config, the launcher row, package scripts) belongs to the `sm` CLI
(`../cli`), and the host reads and changes it only by running
`sm --json` (`host/ipc/cliDelegate.ts`), so the app and a terminal
never disagree. What `host/lib` keeps is what lives in the app's
process (running scripts, mirror sessions, the device link) and the
plain git the CLI has no verb for (diffs, commits, pulls). The browser binding serves none of it (a
tab hosts nothing), so the web client is the desktop with no local
projects: a hostless controller for the account's other devices. The
renderer gates the few surfaces that only make sense with a machine of
its own behind the window (launch tools, this device's settings, port
forwarding) on `renderer/lib/localHost.ts`; everything else is the same
code in both shells. `shared/` is the contract layer every side
compiles.
