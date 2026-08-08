---
name: sgm-add-project
description: Register a repo as a Shigoto no Mori project and configure it. Use when asked to add a project to sgm/Shigoto no Mori, or when an sgm command fails because the repo isn't registered.
---

Run `sgm project add` from inside the repo ("already added" is fine). Then
check `sgm config`: it needs a `defaultBranch` and a `scripts.setup` that
makes a fresh worktree runnable (usually `pnpm install` or equivalent). Fill
gaps with `sgm config --setup '<cmd>' --default-branch <ref>`.
