---
name: sm-new-worktree
description: Create a Shigoto no Mori worktree for new work. Use when starting a task that should run in its own worktree, isolated from the primary checkout.
---

```sh
sm worktrees create
```

Use --base <ref-name> to create a branch from a non-primary ref.

**Rename the branch once the purpose of the worktree has been defined.** It starts out named
after the worktree's random animal name; use `/sm-rename-branch`.

## Notes:

- This runs carry-over and the project's setup script (progress streams to
stderr) and prints the path.
- Exit 3 means the worktree exists but its setup
script failed, and the `cd` never ran so you are still in the primary
checkout: read the output, fix the cause, then retry.
