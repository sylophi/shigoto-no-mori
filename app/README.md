# The app

The Electron desktop app and the web client, combined as one package of the root pnpm workspace. Paths in this document are relative to this directory. The terminal `sm` ([`packages/cli`](../packages/cli)) and the mirroring engine ([`file-sync/`](../file-sync/)) that the app bundles are sibling directories one level up.

- [`DESIGN.md`](DESIGN.md): rules for the visual layer.
- [`ACCOUNT.md`](ACCOUNT.md): the account service (Colibrii and Clerk), its build settings, and Clerk instance configuration.
- [`lab/dev-app.md`](lab/dev-app.md): the builds (prod, dev, and the test flavors), each with its own name, bundle id, scheme, data dir, userData, logs, and `sm`, defined from one table ([`packages/engine/src/flavor.ts`](../packages/engine/src/flavor.ts)) so they can run side by side.
- [`lab/README.md`](lab/README.md): manual testing on the real UI driven with weblab, covering the fake host (any screen posed in a browser) and device windows (the real app running as several devices on one machine).
- [`test/README.md`](test/README.md): the proofs, run by `pnpm test` and lefthook.
- [`host/README.md`](host/README.md): what the host serves, and how a new call works end to end.
- [`main/README.md`](main/README.md): the shell (Electron's main process).
- [`renderer/README.md`](renderer/README.md): the UI both shells run (containers over the views).
- [`web/README.md`](web/README.md): the web client (a device with no host).
- [`headless/README.md`](headless/README.md): the host with no shell, for a machine with no screen.
- [`shared/README.md`](shared/README.md): code shared by the host, the shell, and the clients.

Every side logs through [`shared/log.ts`](shared/log.ts) into both the console and the trace: Effect code uses `Effect.log*` (written by its `logger`), and Promise code uses `log`.

## On Windows

Developing on Windows requires Git for Windows (project scripts and the engine's sh run in its Git Bash) and PowerShell 7 or Windows PowerShell (which terminals run). Like on other OSes, the build requires Node, pnpm, Go (for [`file-sync/`](../file-sync/), [`nativefs/`](../nativefs/), and [`cli-launcher/`](../cli-launcher/)), and Bun (for the terminal `sm`). Building the installer also requires the .NET SDK (for Velopack's `vpk`, [`scripts/package-windows.mts`](scripts/package-windows.mts)). Install scripts are off, so run `pnpm run postinstall` after `pnpm install`.

Windows ships the desktop app only (no headless host or service), on x64 and experimentally on arm64, and its builds are unsigned. Builds are documented in [`lab/dev-app.md`](lab/dev-app.md), device windows in [`lab/devices.md`](lab/devices.md) (which notes Windows-specific steps), and releases in [`lab/release.md`](lab/release.md).

## Layout

One UI, two shells. The desktop window and the browser tab render the same [`renderer/`](renderer/) tree over the same page API ([`renderer/lib/runtime/pageApi.tsx`](renderer/lib/runtime/pageApi.tsx)), which each entry builds and passes to boot. What differs is the binding underneath, and the two bindings are parallel:

| Concern | Desktop (Electron) | Web (browser) |
| --- | --- | --- |
| Composition root: handlers on the wires, the direct plane, the page api | [`host/process/`](host/process/) (the host) + [`main/ipc/register.ts`](main/ipc/register.ts) (the shell) + [`main/preload.ts`](main/preload.ts) + [`renderer/lib/runtime/`](renderer/lib/runtime/) | [`web/ipc/register.ts`](web/ipc/register.ts) + [`web/preload.ts`](web/preload.ts) |
| Transport under the page api | [`shared/ipc/shell.ts`](shared/ipc/shell.ts) (the shell, over a port) + [`shared/remote/hostLink.ts`](shared/remote/hostLink.ts) (the host, over the loopback) | [`web/ipc/localRegistrar.ts`](web/ipc/localRegistrar.ts) (the tab's own modules) + the direct plane (every host, a peer) |
| Account: profile, device name and icon | [`main/electron/account.ts`](main/electron/account.ts) + [`main/core/account/`](main/core/account/) | [`web/account/`](web/account/) |
| Colibrii device: enrollment, hub socket, links | [`host/lib/PeerDevice.ts`](host/lib/PeerDevice.ts) (the host's, node) | [`web/ipc/register.ts`](web/ipc/register.ts) (the tab's, browser) |
| Page entry | [`index.html`](index.html) → [`renderer/index.tsx`](renderer/index.tsx) | [`web/index.html`](web/index.html) → [`web/main.tsx`](web/main.tsx) → [`web/boot.tsx`](web/boot.tsx) |

[`host/`](host/) is what the desktop binding serves: the projects, worktrees, scripts, and git operations of the machine it runs on. It is not the engine for them: the data model (the project list, worktree rows and identities, their marks, config, the launcher row, and package scripts) belongs to the engine ([`../packages/engine`](../packages/engine)). The host runs the engine in-process ([`host/lib/Engine.ts`](host/lib/Engine.ts)) on the same store as the terminal `sm`, so the app and a terminal never disagree. [`host/lib`](host/lib) owns what lives in the host process (running scripts, mirror sessions, and the device link) plus the plain git operations that the engine has no service for (diffs, commits, pulls).

The browser binding serves none of this (a tab hosts nothing), so the web client is the desktop app with no local projects: a hostless controller for the account's other devices. The renderer gates the few surfaces that only make sense with a local machine behind the window (launch tools, this device's settings, port forwarding) using [`renderer/lib/localHost.ts`](renderer/lib/localHost.ts). Everything else runs the same code in both shells. [`shared/`](shared/) contains the code every side compiles, built over the contracts in [`packages/contracts`](../packages/contracts).

The desktop app supports as many windows as the user opens, each acting as a separate client of the host like a browser tab, with its own runtime, links, subscriptions, page, and terminal drawer. The shell tracks the open windows ([`main/electron/windows.ts`](main/electron/windows.ts)): New Window, opening a page in its own window, routing deep links to the window focused last, and restoring each window's page and bounds at the next startup. The app quits when its last window closes.
