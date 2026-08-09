---
name: sgm-switch-worktree
description: Switch to an existing Shigoto no Mori worktree. Use when asked to continue or inspect work that lives in a specific sgm worktree.
---

```sh
wt="$(sgm path <name>)" && cd "$wt"
```

`sgm list` shows what exists (name, branch, sync state). Dev checkouts of
the app install the CLI as `sgmd`; if neither exists, stop and tell the
user.

**Stay inside.** Run every subsequent command from the worktree.
