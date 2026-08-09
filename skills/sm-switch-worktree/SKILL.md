---
name: sm-switch-worktree
description: Switch to an existing Shigoto no Mori worktree. Use when asked to continue or inspect work that lives in a specific sm worktree.
---

```sh
wt="$(sm path <name>)" && cd "$wt"
```

`sm list` shows what exists (name, branch, sync state). Dev checkouts of
the app install the CLI as `smd`; if neither exists, stop and tell the
user. Do not use `sm cd` or `sm wt`: those open interactive subshells
for humans and refuse to run in scripts.

**Stay inside.** Run every subsequent command from the worktree.
