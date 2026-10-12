# host

What a machine serves: its projects, worktrees, scripts, mirrors, port
forwards and device link, run as the app's utility process (V3.md,
decisions 6 and 9). Its data model is the engine's
(`packages/engine`), which it runs in-process (`lib/Engine.ts`,
`lib/engineOps.ts`).

- `process/`: the composition root. `layer.ts` is the host's layer
  graph, `services.ts` names the services the handlers answer on
  (`HostServices`), `handlers.ts` registers every module's handlers,
  `wires.ts` puts them on the loopback and the device link, and
  `graph.ts` is the root's one way into the graph from callbacks that
  are not Effect (EFFECT.md, section 3), which nothing outside
  `process/` uses.
- `ipc/modules/<module>.ts`: one handler table per host-scoped contract
  module, an effect per call over the services, and its views
  (`Views.view`, `lib/Views.ts`).
- `lib/`: the services and what they use. A service module is named
  for its service (`VillagerData.ts`, `GitWatcher.ts`), so the lint
  rules for services read it (`lint/README.md`); lowercase modules are
  helpers, Promise code not converted yet, and the engine calls. A few
  services still sit in lowercase modules (V3.md, step 7, Leftover
  mechanisms).
- `socket/`: the device link's server and its byte channels, and the
  loopback the windows dial. `direct/`, `hub/`: reaching peers.
  `mirror/`, `fileSync/`, `portForward/`: the remote mechanisms.

## A new call, end to end

1. The call in its contract module
   (`packages/contracts/src/modules/<module>.ts`), classified
   (`packages/contracts/README.md`), with its wire sample and the
   classification file regenerated.
2. The capability as a method on the service that owns the domain
   (EFFECT.md, section 1), in `lib/`; a new service also goes into
   `process/layer.ts` and `HostServices`.
3. The handler in `ipc/modules/<module>.ts`: decode, call the method,
   nothing else. The table `satisfies` the contract's handlers type, so
   typecheck fails until the call has one.
4. A new module's table is registered in `process/handlers.ts`
   (`registerContract`, onto `shared/ipc/served.ts`); a new call in an
   existing module needs nothing there. The group's RPC server decodes
   each payload and encodes each answer with the call's schemas.
5. A proof in `app/test` calls the handler on the host's services with
   `runHost(handlers.call(...))` (`app/test/README.md`).
6. The renderer reaches it through its client; the lab's fake host
   answers a call it has no fixture for with a stub derived from the
   schema, so it needs an entry (`app/lab/fake-host/`) only when a
   screen should show something real.
