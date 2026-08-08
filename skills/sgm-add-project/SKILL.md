---
name: sgm-add-project
description: Register a repo as a Shigoto no Mori project and configure it. Use when asked to add a project to sgm/Shigoto no Mori, or when an sgm command fails because the repo isn't registered.
---

Run `sgm project add` from anywhere inside the repo. "Project already
added" is fine; continue.

Then run `sgm config` and check two things: a sensible `defaultBranch`, and
a `scripts.setup` command that makes a fresh worktree runnable (usually the
repo's dependency install, e.g. `pnpm install`). Fill whatever is missing:

```sh
sgm config --setup '<cmd>' --default-branch <ref>
```
