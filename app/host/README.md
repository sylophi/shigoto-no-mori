# host

What a machine serves: its projects, worktrees, scripts, mirrors, port
forwards and device link, run as the app's utility process (below).
Its data model is the engine's (`packages/engine`), which it runs
in-process (`lib/Engine.ts`, `lib/engineOps.ts`).

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
  helpers, Promise code and the engine calls, and `lib/cli/shell.ts`
  holds the one service among them, `HookShell`.
- `socket/`: the device link's server and its byte channels, and the
  loopback the windows dial. `direct/`, `hub/`: reaching peers.
  `mirror/`, `fileSync/`, `portForward/`: the remote mechanisms.

## A process of its own

The host runs apart from the shell so that its work never stalls a
window and a crash of it is a reconnect. The shell forks it at launch
(`main/hostProcess.ts`) and reaches it over RPC as every client does:
a window, the shell and the terminal `sm` on the loopback, the web
client and the other devices over the device link. The shell owns the
account (Clerk, the keychain) and tells the host the account's facts,
which bring its hub socket up, as the host comes up and at every
change. The device identity is the host's, in its store, reported to
the shell as the host comes up. A quit is the shell asking the host
whether it is busy, then closing its scope. It lives in `app/` rather
than a package of its own because it ships only inside the app, built
by the app's Vite config beside the shell and the renderer it serves.

## Commit points

The host's multi-step changes of state, each with the step that
commits it (`EFFECT.md`, section 5); the engine's are in
`packages/engine/README.md`.

- **A transfer's source teardown** (`lib/sync/receipts.ts`): the
  delete commits it, forced when the move captured uncommitted work.
  The receipt is checked before the cleanup, so a source that changed
  keeps its cleanup unrun, and again by the removal on the source's
  own device, after its cleanup and right before the delete
  (`movedSourceChange`, `Worktrees.remove`'s `expect`), since a cleanup
  script or an editor can write to it meanwhile.
- **The clone from a peer** (`lib/sync/cloneFromPeer.ts`): the rename
  of the whole clone into its folder and its register, run
  uninterrupted, commit it. It is built in a `.<name>.partial-<pid>`
  sibling held in a scope, so a failure or a cancel removes it, and a
  dead process's is swept by the next clone of that name. A
  `sm-clone-pending` file in its `.git`, written before the rename and
  removed after the register, lets the next clone of that repo into
  the folder register a clone a crash left between the two.
- **A landing** (`lib/sync/landing.ts`): the caller's run of the
  `keep` it answers with commits it, once the move has nothing left to
  fail. Until then a failure or a cancel undoes its create
  (`Worktrees.createHeld`); after it only a cancel does, at a later
  step of the move (a pull's files step).
- **The data-folder move** (`lib/dataDirMove.ts`): the pointer commits
  it. Its journal, kept in the data folder, is written before the
  re-key: a start that finds it at the source undoes the move, one that
  finds it at the destination finishes it. A rename cut before the
  pointer moves leaves the pointer naming a folder that is gone, so
  every process, the terminal's included, finds the data dir through
  `Paths`, which looks for a rename's journal at the staged pointer's
  target and at the default place, and commits the pointer when that
  journal names the folder that left
  (`packages/engine/src/dataDirMoveJournal.ts`); a process that can't
  write the pointer refuses to resolve, naming both folders. A copy to
  another volume holds the store's write lock for its length, so no
  store write tears the copy. The recovery keeps the journal until
  every step it owes is done, and one it can't read stays, for a look.
  The steps and the undo are in the module's header; the lock that
  makes the move the one change under way is the engine's.
- **Nuke** (`lib/nuke.ts`, then the shell's `main/electron/nuke.ts`):
  the marker the shell writes in userData commits it. The start that
  finds it deletes what it names and userData, the marker last, and
  one that can't read it deletes nothing (`main/core/nuke/finish.ts`).

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
