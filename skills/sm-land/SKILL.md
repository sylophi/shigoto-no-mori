---
name: sm-land
description: Merge a Shigoto no Mori worktree's branch into the primary branch and clean up. Use when work in an sm worktree is finished and should be landed/merged, or when asked to clean up a merged worktree.
---

Land the current worktree's work, then clean up. Commit everything first,
and push if there is a PR.

**Run `sm worktrees land`.** One command does the whole finish line: it merges the
branch's PR (the merge method follows the repo's settings; pass
`--method merge|squash|rebase` only when asked for a specific one),
fast-forwards the checkout that has the PR's base branch out (the
primary checkout for `main`, or a worktree holding a line like `v2`),
and removes the worktree. When run from the primary checkout sitting on the
merged branch, it lands the checkout back on the primary branch instead
of removing anything.

To land a worktree other than the one you are in, pass its name
(`sm worktrees land <name>`) or `cd` into it first.

If there is no PR, `sm worktrees land` stops. Do not merge by other means: tell
the user the branch needs a PR first.

**Stacks.** A PR based on another open PR's branch is a layer of a stack
(`gh stack`, or plain PRs chained by base branch). `sm worktrees land`
refuses such a PR on its own, since merging it alone would fold it into
the layer below rather than land it. Land the stack instead:

```sh
sm worktrees land --stack
```

That merges the PR with every open PR under it, bottom first (a stack
GitHub knows about goes through its atomic stack merge), then removes
every worktree whose branch landed, the lower layers' worktrees included.
All of them must be clean, or the command stops before anything merges.
Landing a layer with open layers above it leaves those based on a branch
that just merged: tell the user, and if the stack is a `gh stack` one,
run `gh stack sync` in the worktree above. To merge a layer into the
layer below on purpose, use `sm worktrees merge` and then `sm worktrees rm`.

If the command reports a skipped catch-up, pass the reason on to the
user.

**Partial failures resume.** If cleanup fails after the merge (a
teardown script, say), fix the cause and re-run `sm worktrees land`: an
already-merged PR skips straight to cleanup. If your shell ends up
inside the removed directory, `cd` to the path the command prints.
