# Tests

End-to-end proofs covering the places where the app deletes or moves the user's files (see [`../../AGENTS.md`](../../AGENTS.md) for the test scope). Each proof is a vitest file in this directory, and [`lib/`](lib/) holds their shared helpers.

- [`nuke.mts`](nuke.mts): nuke refuses its traps and removes only the worktrees the app created, and the next startup deletes only the paths its marker names.
- [`worktree-removals.mts`](worktree-removals.mts): a removal deletes only the worktrees named in its plan, and refuses a worktree that a script dirtied, before any teardown runs.
- [`interrupted-workflows.mts`](interrupted-workflows.mts): killing the terminal `sm` mid-move or mid-removal, and killing the migration's move into `wt/` at each step, are finished or undone by the next startup and by `sm doctor --fix`.
- [`data-dir-move.mts`](data-dir-move.mts): an interrupted data-folder move is finished or undone on the next startup, never deletes a folder it did not create, and is refused while a worktree is in transit.
- [`sync-transfer.mts`](sync-transfer.mts): a move between devices removes the source only once the copy holds it, and a cancelled move keeps nothing that could trigger source removal.
- [`mirror.mts`](mirror.mts), [`mirror-engine.mts`](mirror-engine.mts): a mirror never deletes or overwrites files that are not its own.
- [`mirror-checkout.mts`](mirror-checkout.mts): a mirror copy preserves its original's bytes regardless of the device kind at each end (line endings, symlinks), git reports both ends as clean, the copy's device keeps its other worktrees' own config, and a copy on a device with matching checkout behavior writes nothing into its repository's config.
- [`changes-picks.mts`](changes-picks.mts): a file excluded from a commit that becomes conflicted comes back ticked, so a merge commit includes its resolution and "Discard unticked" leaves it alone.
- [`control.mts`](control.mts): an unmirror removes the copy only once the follower holds it, and never removes the original.
- [`account-upgrade.mts`](account-upgrade.mts): a device signed in on a build before Colibrii is treated as waiting to sign in again rather than signed out, so its first startup after the upgrade keeps its mirrors.

Tests run one file at a time, each in its own process ([`../vitest.config.ts`](../vitest.config.ts)), because they spawn real git, the real `sm` and file-sync binaries, and sockets. `pnpm test` runs all proofs, and `pnpm test <name>` runs the files whose name contains `<name>`. lefthook runs them for changes to what they exercise ([`../../lefthook.yml`](../../lefthook.yml)), except on Windows, and CI runs them on each pull request.

No proof's git process can reach this repository: the vitest config removes every `GIT_*` variable and sets `GIT_CEILING_DIRECTORIES` ([`../../test/gitIsolation.ts`](../../test/gitIsolation.ts)), and each proof runs git through `sandboxGit` or `scrubProcessGitEnv` ([`lib/checkKit.mts`](lib/checkKit.mts)), which add a fixture identity. Each run puts its temp files and `XDG_CONFIG_HOME` in its own folder ([`../../test/testTemp.mts`](../../test/testTemp.mts)) that is removed when the run exits, so proofs do not need to clean up after themselves.
