---
name: sgm-rename-branch
description: Rename the current git branch to a short, descriptive name. Use before opening a PR, or whenever a branch carries a random or placeholder name.
---

Check the current branch name. If it looks like a random or placeholder
name (e.g. a nonsense animal name), rename it to something short and
descriptive that fits the actual changes (e.g. "fix-stale-session-cleanup"):

```sh
git branch -m <new-name>
```

If the old name was already pushed, move the remote too:

```sh
git push -u origin HEAD && git push origin --delete <old-name>
```
