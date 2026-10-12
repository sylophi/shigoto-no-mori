# shared

The app's code that more than one of its sides compiles: the host, the
shell (`main/`), the renderer and the web client. What crosses a wire
or every package needs is the contracts' (`packages/contracts`); what
is here is the app's own.

- `remote/`, `hub/`, `crypto/`: reaching a device. The device link's
  client and its sealed socket, the loopback the windows dial
  (`remote/hostLink.ts`), the hub connection and the direct plane that
  dials peers through it, and the Noise handshake and device keys.
- `ipc/`: what a side serves, module by module, for its RPC server
  (`served.ts`); a module's client, its invokes as effects over a link
  (`effectClient.ts`); and the window's port to its shell (`shell.ts`).
- `paths.ts`, `shellEnv.ts`, `observability.ts`, `lifetimes.ts`,
  `layerLatch.ts`, `hostFacts.ts`: what the host and the shell both
  compile (the data dir, the login shell's environment, the logger and
  tracer, the layer helpers, the facts the shell hands its host).
- `account/`: enrollment and the credential store both shells use.
- `log.ts`: the app's `logger`, which writes Effect code's `Effect.log*`
  lines, and `log` for Promise code, so a line from either reads the
  same in the trace (EFFECT.md, section 7). `config.ts`: an environment setting for Promise code.
- The rules two sides must apply alike, as pure functions:
  `busy.ts`, `launchRow.ts`, `reorder.ts`, `pullCollision.ts`,
  `cloneDestination.ts`, `cloneUrl.ts` (the add-project flow's reading
  of a pasted string, over `predicates/remoteUrl.ts` in the contracts),
  `releases.ts`, `ports/`, `villagers/`.
- `packaging/`: the build's own modules (the flavor's names, the
  bundled binaries, signing, the dmg), run by forge and the scripts.

A rule the contracts hold (a predicate, a schema's check) is tested in
the contracts' suite; a case here, or in a proof in `app/test`, tests
what the app does with it.
