---
name: sgm-land
description: Merge a Shigoto no Mori worktree's branch into the primary branch and clean up. Use when work in an sgm worktree is finished and should be landed/merged, or when asked to clean up a merged worktree.
---

Land the current worktree's work, then clean up. Commit everything first,
and push if there is a PR.

**Merge.** With a PR, run `sgm merge`: it picks the merge method from the
repo's settings. Pass `--method merge|squash|rebase` only when asked for a
specific one. Without a PR, merge locally into the primary checkout:

```sh
git -C "$(sgm list --json | jq -r '.[]|select(.isPrimary).path')" merge <branch>
```

**Clean up.** Run `sgm rm <name>` for a worktree you're finished with, or
`sgm done` when you're in the primary checkout sitting on the merged
branch.
