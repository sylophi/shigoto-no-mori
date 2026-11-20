---
name: sm-for-agents
description: "Shigoto no Mori (sm) features for agents: worktree titles and app links. Use when working with sm and you need better ways to interface with the user."
---

These let the user follow your work in the app without asking. Outside
a Shigoto no Mori worktree, skip them.

## Title and description

Once the work's purpose is clear:

```sh
sm describe -t "<title>" --description-file - <<'EOF_DESC'
<description>
EOF_DESC
```

Write them like a PR's title and body: short, what and why, and what's
left to do. Run it again whenever they stop being true. Once the branch
has an open PR, the PR's title and body take over and describe refuses
to change them.

## Links

`sm link` prints a link that opens the worktree in the app. Add `/diff`
to it to open its changes.
