---
name: sm-land
description: Merge a Shigoto no Mori worktree's branch into the primary branch and clean up. Use when work in an sm worktree is finished and should be landed/merged, or when asked to clean up a merged worktree.
---

Land the current worktree's work, then clean up. Commit everything first,
and push if there is a PR.

**Merge.** Run `sm merge`: it merges the branch's PR and picks the merge
method from the repo's settings. Pass `--method merge|squash|rebase` only
when asked for a specific one. If there is no PR, do not merge by other
means: stop and tell the user the branch needs a PR first.

**Catch up.** The merge landed on the remote; fast-forward the local
primary checkout so it sees it:

```sh
git -C "$(sm path root)" pull --ff-only
```

**Clean up.** Run `sm rm <name>` for a worktree you're finished with, or
`sm done` when you're in the primary checkout sitting on the merged
branch.
