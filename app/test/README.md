# Tests

The programmatic checks: proofs that run unattended, with no window,
account or second device. Testing by hand, on the real UI, is the
lab's (`../lab/README.md`).

Each proof is a standalone script at the top of this directory that
exits non-zero when it fails, and `lib/` holds what they share.
`pnpm test` lists them and `pnpm test <name>` runs one (`run.mts`, the
runner, has the other forms). CI runs every one on each pull request
(`pnpm test --all`, in `.github/workflows/checks.yml`). The hub has its
own suite in `../../hub`.

On commit, lefthook runs the proofs the staged files reach
(`pnpm test --changed <path>...`, and `--list` names them without
running), and `lefthook run pre-commit --all-files` runs the lot. The
paths are repo-relative, the way lefthook passes them. A proof is
reached through:

- its imports, followed through the whole graph the way node loads
  them (the aliases and extensionless paths of `lib/tsAliasLoader.mts`).
  Type-only imports don't count: node never loads them, and typecheck
  holds the types.
- a `// covers:` line in it, or in any module it imports, naming
  repo-relative globs for what reaches it without an import:

  ```ts
  // covers: app/shared/fixtures/**
  ```

  A proof that builds `sm` covers `cli/**` through `lib/smBinary.mts`.
  Add a line for a file the proof reads off disk, a directory it
  scans or a binary it builds. The globs are `path.matchesGlob`'s, so
  `**` skips dotfiles. `proof-selection` fails on a covers glob that
  matches no tracked file.

Every proof imports `lib/checkKit.mts` and runs under the loader, so a
change to either runs them all. That includes `keychain`, which writes
to the login keychain, but only an item it creates and deletes itself,
and CI runners are thrown away after each run.

`--changed` also runs the hub's check (`pnpm -C hub run check`, after
installing `hub/`) alongside the proofs, for a change under `hub/` or
to an app file the hub's sources import. There type-only imports count
too, since the check runs tsc. `--all` is proofs only: CI checks the
hub in a job of its own.

`--all` and `--changed` kill a check that runs past
`SHIGOMORI_PROOF_TIMEOUT_MINUTES` (10 by default) and count it failed.

To add one, add `<name>.mts` here, with a covers line for anything it
depends on without importing it.
