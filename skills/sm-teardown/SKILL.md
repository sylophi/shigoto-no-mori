---
name: sm-teardown
description: Tear down a Shigoto no Mori worktree. Use when the user asks to discard or abandon a worktree.
---

One command does the whole teardown:

```sh
sm worktrees rm <name>
```

- releases the port-pool port
- runs the project's teardown script
- `git worktree remove`
- force-deletes the branch, unmerged commits included
- drops the app's record of the worktree

Note: you do not need to provide a worktree name if you are in the one you
are trying to remove. `sm worktrees list` names the rest.
Note: if a user requests this skill, it is an indication that they want to
discard the work. Do not ask to retain it.

The removal is local only, so delete the remote branch too, unless the
branch was never pushed. Note its name before the removal takes the local
one, then:

```sh
git push origin --delete <branch>
```

This closes any open PR on it.

## Failure cases

- **Uncommitted changes**, or a status it cannot read: refuses. Commit or
  stash what matters, then pass `-f`, which skips only this check.
- **The primary checkout**: refuses, nothing to remove. `sm worktrees done`
  is what lands a merged checkout back on the primary branch.
- **A cleanup script exits non-zero**: stops and leaves the worktree in
  place, naming the phase that failed. Fix the cause and re-run, or re-run
  with `--skip-cleanup` to go straight to the git removal.
- **Your shell was inside it**: the directory is gone, so `cd` to the path
  the command prints before running anything else.
