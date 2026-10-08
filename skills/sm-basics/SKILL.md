---
name: sm-basics
description: "Shigoto no Mori (sm) basics: register a project, and create, rename, land or tear down worktrees."
---

## Register a project

```sh
sm projects add
```

Run it from inside the repo. "Project already added" is fine.
`sm projects add <folder> --all --yes` adds every repo under a folder.

Then check `sm projects config` for a sensible `defaultBranch` and a
`scripts.setup` that makes a fresh worktree runnable (usually the
dependency install). Fill in what's missing:

```sh
sm projects config --setup '<cmd>' --default-branch <ref>
```

## Create a worktree

```sh
sm worktrees create --no-cd
```

`cd` to the path it prints. `--base <ref>` branches from another ref.
If the setup script fails, fix it and run `sm worktrees setup <name>`
rather than creating it again.

## Rename its branch

A new branch is named after a random animal. Once the work is clear:

```sh
git branch -m <new-name>
```

If the old name was already pushed, also run
`git push -u origin HEAD && git push origin --delete <old-name>`.
Don't rename a branch that has a PR.

## Land it

Commit and push first. Then:

```sh
sm worktrees land
```

It merges the PR and removes the worktree. Without a PR it stops: tell
the user the branch needs one, and don't merge another way. If it armed
auto-merge instead, it waits for GitHub to merge the PR, as long as the
checks take, so run it where a long command won't time out. If it stops
saying the PR needs attention, deal with that and run it again.
`--stack` from the top layer lands a whole PR stack.

## Tear it down

When the user wants to discard a worktree, don't ask to keep the work:

```sh
sm worktrees rm
```

It refuses uncommitted changes, and `-f` overrides that. The removal is
local, so delete the remote branch too if it was pushed:
`git push origin --delete <branch>`.

After land or rm, if your shell was inside the worktree, `cd` to the
path the command prints.
