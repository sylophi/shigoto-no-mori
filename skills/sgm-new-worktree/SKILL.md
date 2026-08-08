---
name: sgm-new-worktree
description: Create a Shigoto no Mori worktree for new work. Use when starting a task that should run in its own worktree, isolated from the primary checkout.
---

Create the worktree and move into it:

```sh
cd "$(sgm create)"
```

This runs carry-over and the project's setup script (progress streams to
stderr) and prints the path. Exit 3 means the worktree exists but its setup
script failed: read the output, fix the cause, then `sgm setup` to retry
before relying on the environment.

**Stay inside.** Run every subsequent command from the worktree.

**Rename the branch once the work has taken shape.** The branch starts out
named after the worktree's random animal name. Rename it to something short
and descriptive that fits the actual changes (e.g.
"fix-stale-session-cleanup"):

```sh
git branch -m <new-name>
```
