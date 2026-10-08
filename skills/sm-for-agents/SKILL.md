---
name: sm-for-agents
description: "Shigoto no Mori (sm) features for agents: worktree titles, agent sessions, and app links. Use when working with sm and you need better ways to interface with the user."
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
left to do. Run it again whenever they stop being true. Once there's a
PR, edit the PR instead.

## Agent sessions

When you start work in a worktree, bind your session to it:

```sh
sm agents bind
```

On Claude Code or Codex, any `sm` command run inside the worktree
already does this, so there's no need.

## Links

`sm link` prints a link that opens the worktree in the app. Add `/diff`
to it to open its changes.
