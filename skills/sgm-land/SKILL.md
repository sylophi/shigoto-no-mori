---
name: sgm-land
description: Merge a Shigoto no Mori worktree's branch into the primary branch and clean up. Use when work in an sgm worktree is finished and should be landed/merged, or when asked to clean up a merged worktree.
---

Everything committed (and pushed, if there's a PR) first.

Merge: `sgm merge` when there's a PR (method follows the repo's settings).
Otherwise merge locally:
`git -C "$(sgm list --json | jq -r '.[]|select(.isPrimary).path')" merge <branch>`

Clean up: `sgm rm <name>` for a worktree you're finished with, or `sgm done`
if you're in the primary checkout sitting on the merged branch.
