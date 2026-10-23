# Tests

The proofs: what the app does where it deletes or moves the user's
files, end to end (the scope is in `../../AGENTS.md`). Each is a vitest
file here, and `lib/` holds what they share.

- `nuke.mts`: the nuke refuses its traps and removes only the
  worktrees the app made, and the next start deletes only what its
  marker names.
- `worktree-removals.mts`: a removal takes only the worktrees its plan
  named, and refuses one a script dirtied before any teardown.
- `interrupted-workflows.mts`: the terminal `sm` killed in a worktree
  move or removal, and the migration's move into `wt/` killed at each
  step, finished or undone by the next start and by `sm doctor --fix`.
- `data-dir-move.mts`: a data-folder move cut short, finished or undone
  at the next start, never deleting a folder it didn't make, and
  refused while a worktree is in transit.
- `sync-transfer.mts`: a move between devices takes the source only
  once the copy holds it, and a cancelled one keeps nothing that could.
- `mirror.mts`, `mirror-engine.mts`: a mirror never deletes or
  overwrites what isn't its own.
- `control.mts`: an unmirror removes the copy only once the follower
  holds it, and never the original.

They run one file at a time, each in a process of its own
(`../vitest.config.ts`), since they spawn real git, the real `sm` and
file-sync binaries and sockets. `pnpm test` runs them all, and
`pnpm test <name>` the files whose name holds it. lefthook runs them
for a change to what they run (`../../lefthook.yml`), and CI on each
pull request.

No proof's git can reach this repository: the vitest config removes
every `GIT_*` variable and sets `GIT_CEILING_DIRECTORIES`
(`../../test/gitIsolation.ts`), and a proof runs git through
`sandboxGit` or `scrubProcessGitEnv` (`lib/checkKit.mts`), which add a
fixture's identity. A run's temp files and its `XDG_CONFIG_HOME` are in
a folder of its own (`../../test/testTemp.mts`), removed as the run
exits, so a proof cleans up nothing of its own.
