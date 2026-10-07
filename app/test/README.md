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
  `sm` covers `cli/**` through `lib/smBinary.mts`. Add a line for a
  file the proof reads off disk, a directory it scans or a binary it
  builds. The globs are `path.matchesGlob`'s, so `**` skips dotfiles.
  `proof-selection` fails on a covers glob that matches no tracked
  file.

`lib/checkKit.mts` covers `../vitest.config.ts`, so a change to the
config runs every proof that imports the kit. That includes
`keychain`, which writes to the login keychain, but only an item it
creates and deletes itself, and CI runners are thrown away after each
run.

To add one, add `<name>.mts` here, with a covers line for anything it
depends on without importing it.
