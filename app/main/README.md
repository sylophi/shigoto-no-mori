# main

The shell: Electron's main process. It keeps what decision 6 leaves in
Electron (the windows, the menu, dialogs, the keychain, the
updater) and runs the host as a utility process of its own (V3.md,
decisions 6 and 9).

- `index.ts`: the shell's start, the composition root. It builds the
  shell's runtime over `shellLayer.ts`, its layer graph, and quits with
  the last window. `flavor.ts` is this build's flavor (prod, test or
  dev) and its names.
- `hostProcess.ts`: the shell's hold on its host. It forks
  `host/process/host.ts` with its facts, serves the host's calls back to
  the shell (`shellCalls`) over a port, and forks it again when it exits
  unasked.
- `preload.ts`, `preloadPort.ts`, `argFlags.ts`: what a window starts
  with. The preload reads the facts main hands it on argv (`argFlags.ts`,
  one module for both sides) and asks for the port the window's calls
  to its shell ride.
- `ipc/`: the shell's link to its windows (`shellLink.ts`), and
  `modules/`, one handler table per client-scoped contract module (the
  window, menu, dialogs, shell, nav, migration, account, client config,
  releases).
- `electron/`: the modules that need Electron: windows, the menu, deep
  links, Clerk's bridge and its tokens, the updater, liveness, nuke's
  live half, the log file.
- `core/`: the shell's logic that runs without Electron, so a proof
  drives it under plain node: the account's credential store and default
  device name, the keychain reset, liveness's rate limits, and the start
  after a nuke.

A window reaches its host over the loopback like any other device; its
shell serves only the calls that belong to the machine the window runs
on.
