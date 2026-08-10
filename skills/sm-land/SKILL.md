---
name: sm-land
description: Merge a Shigoto no Mori worktree's branch into the primary branch and clean up. Use when work in an sm worktree is finished and should be landed/merged, or when asked to clean up a merged worktree.
---

Land the current worktree's work, then clean up. Commit everything first,
and push if there is a PR.

**Run `sm worktrees land`.** One command does the whole finish line: it merges the
branch's PR (the merge method follows the repo's settings; pass
`--method merge|squash|rebase` only when asked for a specific one),
fast-forwards the local primary checkout so it sees the merge, and
removes the worktree. When run from the primary checkout sitting on the
merged branch, it lands the checkout back on the primary branch instead
of removing anything.

If there is no PR, `sm worktrees land` stops. Do not merge by other means: tell
the user the branch needs a PR first.

**Partial failures resume.** If cleanup fails after the merge (a
teardown script, say), fix the cause and re-run `sm worktrees land`: an
already-merged PR skips straight to cleanup. If your shell ends up
inside the removed directory, `cd` to the path the command prints.
