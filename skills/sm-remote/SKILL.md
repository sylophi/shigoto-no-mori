---
name: sm-remote
description: Move or mirror a Shigoto no Mori (sm) worktree between the user's machines.
---

The app must be open and signed in on both machines. If a command says
it isn't running, open it with `sm app` and retry once `sm devices`
shows the other machine as ready.

## Send it to the user

For "send it to me" or "let me test this":

```sh
sm worktrees mirror --to <device>
```

It lands on their machine, uncommitted changes included, and the two
copies follow each other from then on. Tell them the path it prints.

## Take over their work

For "take over" or "continue what I did":

```sh
sm worktrees list --remote
sm worktrees mirror <name> --from <device>
```

`cd` to the path it prints. If their machine refuses, tell the user to
turn on command access there (Settings, Account).

## Stop mirroring

```sh
sm worktrees unmirror
```

It removes the copy, never the original. Pass `-f` only when the user
says the copy can go.

## Notes

- With several machines, ask the user which one they're on.
- `send` and `bring` move a worktree once instead of mirroring it. Use
  them only when asked, and pass `--source teardown` (which deletes the
  original) only when the user asks for it.
- Exit 3 means it landed but a later step didn't. Pass the lines marked
  `!` on to the user, and don't retry.
