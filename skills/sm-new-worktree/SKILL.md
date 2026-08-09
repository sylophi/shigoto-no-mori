---
name: sm-new-worktree
description: Create a Shigoto no Mori worktree for new work. Use when starting a task that should run in its own worktree, isolated from the primary checkout.
---

Create the worktree and move into it:

```sh
wt="$(sm create)" && cd "$wt"
```

(The `&&` matters: if `sm` fails or is missing, a bare `cd "$(...)"` can
succeed silently and leave you in the primary checkout. Dev checkouts of the
app install the CLI as `smd`; if neither exists, stop and tell the user.)

This runs carry-over and the project's setup script (progress streams to
stderr) and prints the path. Exit 3 means the worktree exists but its setup
script failed: read the output, fix the cause, then `sm setup` to retry
before relying on the environment.

**Stay inside.** Run every subsequent command from the worktree.

**Rename the branch once the work has taken shape.** It starts out named
after the worktree's random animal name; use `/sm-rename-branch`.
