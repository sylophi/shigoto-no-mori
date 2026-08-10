---
name: sm-switch-worktree
description: Switch to an existing Shigoto no Mori worktree. Use when asked to continue or inspect work that lives in a specific sm worktree.
---

```sh
wt="$(sm worktrees path <name>)" && cd "$wt"
```

`sm worktrees list` shows what exists (name, branch, sync state). The
reserved name `root` (or `primary`) targets the primary checkout:
`sm worktrees path root`. Dev checkouts of the app install the CLI as
`smd`; if neither exists, stop and tell the user. Do not use `sm cd`
or `sm worktrees switch`: those open interactive subshells for humans
and refuse to run in scripts.

**Stay inside.** Run every subsequent command from the worktree.
