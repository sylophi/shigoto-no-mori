# shared

The app's code that more than one of its sides compiles: the host, the
shell (`main/`), the renderer and the web client. What crosses a wire
or every package needs is the contracts' (`packages/contracts`). What
is here is the app's own.

- `remote/`, `hub/`: reaching a device. The device link's client over
  a Colibrii link (`remote/linkSocket.ts`) and its greeting, the
  loopback the windows dial (`remote/hostLink.ts`), and the direct
  plane that dials peers through this device's Colibrii device.
- `ipc/`: what the shell and a web tab serve, module by module
  (`served.ts`), a push as it goes out, checked at its source
  (`push.ts`), a module's client, its invokes as effects over a link
  (`effectClient.ts`), and the window's port to its shell (`shell.ts`).
- `paths.ts`, `shellEnv.ts`, `observability.ts`, `lifetimes.ts`,
  `layerLatch.ts`, `hostFacts.ts`, `cliLaunchers.ts`: what the host and
  the shell both compile (the data dir, the login shell's environment,
  the logger and tracer, the layer helpers, the facts the shell hands
  its host, the terminal command's place on the Windows PATH).
- `account/`: the account calls every shell serves, and the profile
  (name, icon, command switch) kept beside Colibrii's enrollment.
- `log.ts`: the app's `logger`, which writes Effect code's `Effect.log*`
  lines, and `log` for Promise code, so a line from either reads the
  same in the trace (EFFECT.md, section 7). `config.ts`: an environment setting for Promise code.
- The rules two sides must apply alike, as pure functions:
  `busy.ts`, `reorder.ts`, `pullCollision.ts`,
  `cloneDestination.ts`, `cloneUrl.ts` (the add-project flow's reading
  of a pasted string, over `predicates/remoteUrl.ts` in the contracts),
  `releases.ts`, `ports/`, `villagers/`.
- `packaging/`: the build's own modules (the flavor's names, the
  bundled binaries, signing, the dmg), run by forge and the scripts.
