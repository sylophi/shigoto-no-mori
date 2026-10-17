# Tests

The programmatic checks: proofs that run unattended, with no window,
account or second device. Testing by hand, on the real UI, is the
lab's (`../lab/README.md`).

Each proof is a vitest file at the top of this directory, and `lib/`
holds what they share. They run one file at a time, each in a process
of its own (`../vitest.config.ts`), since they spawn real git, the real
`sm` and file-sync binaries, sockets and workerd, and some bind fixed
ports. `pnpm test` runs them all, `pnpm test <name>` runs one, and
flags pass through to vitest (`run.mts`, the runner, has the other
forms). CI runs every one on each pull request (`pnpm test`, in
`.github/workflows/checks.yml`). The hub has its own suite in
`../../hub`, which lefthook runs for a change under `hub/`, to an app
file the hub imports, or to the workspace's lockfile or settings (the
glob in `lefthook.yml`).

On commit, lefthook runs the proofs the staged files reach
(`pnpm test --changed <path>...`), and `lefthook run pre-commit
--all-files` runs the lot. The paths are repo-relative, the way
lefthook passes them. A proof is reached through:

- its imports, followed through the whole graph by `vitest related`.
  Type-only imports don't count: they are gone once vite strips the
  types, and typecheck holds the types.
- a `// covers:` line in it, or in any module it imports, naming
  repo-relative globs for what reaches it without an import:

  ```ts
  // covers: app/shared/fixtures/**
  ```

  A changed path that matches a covers glob hands the file declaring
  it to `vitest related` (`lib/covers.mts`), so a proof that builds
  `sm` covers `packages/cli/**` through `lib/smBinary.mts`. Add a line for a
  file the proof reads off disk, a directory it scans or a binary it
  builds. The globs are `path.matchesGlob`'s, so `**` skips dotfiles.
  `proof-selection` fails on a covers glob that matches no tracked
  file.

`lib/checkKit.mts` covers `../vitest.config.ts`, so a change to the
config runs every proof that imports the kit. That includes
`keychain`, which writes to the login keychain, but only an item it
creates and deletes itself, and CI runners are thrown away after each
run.

To add one, add `<name>.mts` here, named for what it proves (the
module or the behaviour: `clone.mts`, `git-watcher.mts`), with a
covers line for anything it depends on without importing it. A rule
that lives in a package (a contracts predicate, an engine service) is
tested in that package's suite; a proof here tests what the app does
with it.

No proof's git can reach this repository. The runner and the vitest
config isolate every proof's process (`../../gitIsolation.ts`, which
the engine's and the terminal's test configs apply too): every `GIT_*`
variable is removed, so the pre-commit hook's `GIT_DIR` and
`GIT_INDEX_FILE` never get through, and `GIT_CEILING_DIRECTORIES` stops
a git started in a folder inside the repository from finding it.
`git-isolation` fails if either gets through. A proof still builds its
repositories under the temp dir and runs git there, through
`sandboxGit` or `scrubProcessGitEnv` (`lib/checkKit.mts`), which also
cut off the global and system git config.

Every run's temp files go in a folder of the run's own,
`$TMPDIR/sm-test/<family>/<id>/`: the runner and each vitest config
point TMPDIR there before a test starts (`../../testTemp.mts`), so a
proof needs no cleanup of its own for what a killed process leaves.
The folder goes as the run exits, and a run killed before that leaves
a folder the next run of any suite sweeps (`test-temp`). Nothing
outlives a run, so a build the proofs share (`lib/smBinary.mts`) is
made once per run.

A case that waits on real git, processes or sockets runs slower on a
loaded machine. One that fails under load and passes alone is waiting
on a deadline too short for that: give it one that fits, or wait on
the condition (`waitFor`), rather than retrying.

## Shared fakes

`lib/` holds the stand-ins the proofs share, so a proof sets up only
what it alone is about.

- `hubStub.mts`, the stub device hub: a ws server playing the hub's
  Durable Object (relay, presence, nacks, supersede), with counters a
  proof reads to show a frame never rode it, and `testDeviceKey`, the
  key every test device seals with. `hubBoot.mts` boots a REAL hub
  connection on it.
- `directBoot.mts`, the direct sandbox: two devices on a REAL direct
  link, named by their part in it, `DIALER` and `LISTENER`, in every
  proof. `startDirectListener` is the listener (its ticket store, its
  roster, its command and sharing switches, the proof's own handlers
  through `registerHandlers`). `dialing` and `dialListener` dial it
  straight, sealed with the test keys, each default (who dials, who it
  expects, the ticket, the deadline, the socket) a parameter.
  `bridgeTo` puts the dialer's REAL direct plane in front of a
  listener through a stub hub of its own (`supervised` lets the keeper
  dial), and `bootDirectWire` is the whole wire the transfer proofs
  ride: the listener serving the proof's contracts, the dialer's
  session up, and `toListener`, a transport aimed at the listener.
- `cliSandbox.mts`: one temp tree holding the data dir and the repos,
  the terminal `sm` on it, git over the scrubbed environment, and the
  repo fixtures (`initRepo`, `cloneRepo` for the same project on the
  other device, `addWorktree`, `commitFile`).
- `mirrorFakes.mts`: a session as the mirror daemon reports one
  (`rawMirrorSession`, `mirrorEndpoint`) and a mirror impl with nothing
  behind it (`inertMirrorImpl`), for a proof to fill in with what it is
  about.
- `hostRuntime.mts`: the host's services, up for every proof's file
  (`hostSetup.mts`, vitest's setup file). A proof runs a handler on
  them with `runHost(handlers.call(input))`, and one that drives the
  host's engine calls points the host's data dir at the file's engine
  first (`initDataDirAt(engineDataDir)`).

A proof of something on the direct link starts from the listener and
adds its handlers:

```ts
const listener = await startDirectListener(trackTest, {
  registerHandlers: (binding) => binding.handle(ECHO, async (_ctx, raw) => raw),
});
const connection = await dialListener(trackTest, listener);
```

and one of a transfer from `bootDirectWire(track, { contracts })`.
