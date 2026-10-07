---
name: sm-new-worktree
description: Create a Shigoto no Mori worktree for new work. Use when starting a task that should run in its own worktree, isolated from the primary checkout.
---

```sh
sm worktrees create --no-cd
```

`--no-cd` keeps it from opening a subshell in the new worktree and waiting there.

Use --base <ref-name> to create a branch from a non-primary ref.

**Name the work once the purpose of the worktree has been defined**: rename the branch,
which starts out named after the worktree's random animal name, and give the worktree a
title and description, then keep them current as the work moves. Use `/sm-name-worktree`.

## Notes:

- This runs carry-over and the project's setup script (progress streams to
stderr) and prints the path. `cd` to it.
- Exit 3 means the worktree exists but a step after the create (usually the
setup script) failed. Read the output, fix the cause, then re-run the setup
with `sm worktrees setup <name>` rather than creating it again.
