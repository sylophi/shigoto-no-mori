# main

The shell: Electron's main process. It keeps what decision 6 leaves in
Electron (the windows, the menu, dialogs, the keychain, the
updater) and runs the host as a utility process of its own (V3.md,
decisions 6 and 9).

- `index.ts`: the shell's start, the composition root. It builds the
  shell's runtime over `shellLayer.ts`, its layer graph, and quits with
  the last window. `flavor.ts` is this build's flavor (prod, test or
  dev) and its names.
- `hostProcess.ts`: the shell's hold on its host, the top layer of
  the shell's graph. It forks `host/process/host.ts` with its facts,
  serves the host's calls back to the shell (`shellCalls`) over a port,
  forks it again when it exits unasked, and asks it to quit as the
  graph closes.
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
- Adding a menu item (`electron/menu.ts`): one a window handles is a
  push to the focused window, `clickBroadcast(<contract>, "<push>",
  <payload>)`,
  with the push declared in the client module (`nav`, `window`) and
  heard in the renderer; one the shell handles itself is a plain
  `click`. Labels are title case, as macOS's own are ("Add Project…",
  "New Window"), with an ellipsis when the item asks for more first.
- `core/`: the shell's logic that runs without Electron, so a proof
  drives it under plain node: the account's credential store and default
  device name, the keychain reset, liveness's rate limits, the start
  after a nuke, and the shell's own JSON files (`files/`: the ones it
  writes on the way out, synchronously, and the rest on `FileSystem`).

A window reaches its host over the loopback like any other device; its
shell serves only the calls that belong to the machine the window runs
on.

The shell reads the data dir: `index.ts` finds it (`initDataDir`)
before it builds the menu or forks the host, and modules here read it
through `@host/lib/util/paths`, which moves to `app/shared` with the
other code both processes compile (V3.md, step 7, Leftover mechanisms).
Most of the shell is plain Electron code (the menu, windows, deep
links); EFFECT.md holds what is Effect here: the layer graph
(`shellLayer.ts`), the services (`ClerkTokens`, `ShellLink`) and the
handlers.
