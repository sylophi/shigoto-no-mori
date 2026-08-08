---
name: sgm-new-worktree
description: Create a Shigoto no Mori worktree for new work. Use when starting a task that should run in its own worktree, isolated from the primary checkout.
---

`cd "$(sgm create)"` — creates the worktree, runs its setup, prints the
path. Stay in there for all subsequent commands. Exit 3 means the worktree
was created but its setup script failed — fix that before relying on the
environment.

Once the work has taken shape, the branch still carries the worktree's
random animal name; rename it to something short and descriptive that fits
the actual changes with `git branch -m <new-name>`.
