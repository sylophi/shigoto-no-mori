---
name: sm-add-project
description: Register a repo as a Shigoto no Mori project and configure it. Use when asked to add a project to sm/Shigoto no Mori, or when an sm command fails because the repo isn't registered.
---

Run `sm projects add` from anywhere inside the repo. "Project already
added" is fine; continue.

To register every repo under a folder at once (`--yes` answers the
confirmation, which can't be shown to you):

```sh
sm projects add <folder> --all --yes
```

`sm projects remove <name> --yes` unregisters a project. Its files stay
on disk.

Then run `sm projects config` and check two things: a sensible
`defaultBranch`, and a `scripts.setup` command that makes a fresh worktree
runnable (usually the repo's dependency install, e.g. `pnpm install`).
Fill whatever is missing:

```sh
sm projects config --setup '<cmd>' --default-branch <ref>
```
