---
name: sm-name-worktree
description: Name a Shigoto no Mori worktree's work, by renaming its branch and giving it a title and description like a pull request's, and keep them current. Use as soon as the worktree's purpose is clear, whenever a branch carries a random or placeholder name, and again whenever the work's scope or state changes.
---

A new worktree's branch is named after its random animal folder, and it
has no title. Name the work as soon as its purpose is clear. The app
shows the title in place of the branch, and the description on the
worktree page.

## 1. Rename the branch

If the branch name looks random or like a placeholder (e.g. an animal
name), rename it to something short and descriptive that fits the work
(e.g. "fix-stale-session-cleanup"):

```sh
git branch -m <new-name>
```

If the old name was already pushed, move the remote too:

```sh
git push -u origin HEAD && git push origin --delete <old-name>
```

## 2. Give it a title and description

```sh
sm describe -t "<title>" --description-file - <<'EOF_DESC'
<description>
EOF_DESC
```

- **Title:** one line, written like a PR title (e.g. "Expire port
  leases after a TTL").
- **Description:** markdown, written like a PR body: what the change
  does and why, and what is left to do while the work is in progress.
  Keep it short.
- Each flag replaces only its own field: `sm describe -t "<title>"`
  leaves the description as it is, and `-d ""` clears it.
- `sm describe` with no flags prints the current title and description.

Outside a Shigoto no Mori worktree, skip this step.

## 3. Keep the description current

Run `sm describe` again whenever the title or description stops being
true: the scope grows or shrinks, the approach changes, a to-do gets
done. Don't wait to be asked.

## Once there is a pull request

The PR's title and body take over, and `sm describe` refuses a change.
Edit the PR instead (`gh pr edit --title … --body …`), and leave the
branch name alone, since renaming it would detach the PR. When opening
the PR, start from the worktree's title and description.
