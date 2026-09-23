---
name: sm-share-worktree
description: Move or mirror a Shigoto no Mori worktree between the user's devices. Use when the user asks to send, mirror, or share a worktree to their machine so they can test it, or to take over, bring, or continue work they did on another machine.
---

The app must be open and signed in on both machines. If a command says the
app isn't running, open it with `sm app` and retry once `sm devices` shows
the other machine as ready. If it comes up signed out, tell the user.

**"Send it to me", "let me test this": mirror your worktree to them.**

```sh
sm worktrees mirror [<name>] [--to <device>]
```

The worktree lands on their machine with its uncommitted changes, and the two
follow each other from then on. Tell them the path it reports.

**"Take over what I did locally": mirror their worktree to you.**

```sh
sm worktrees list --remote
sm worktrees mirror <name-or-branch> --from <device>
```

It makes a new worktree here, so `cd` to the path it prints. Their original
stays and follows your work.

The primary checkout can be mirrored too. Its copy lands as a worktree on
`mirror/<branch>` beside the other machine's own primary, and commits cross
between the two branches. It cannot be sent or brought.

`send` and `bring` take the same arguments and move the worktree once instead
of mirroring it. Use them only when asked. `--source teardown` deletes the
original along with any ignored files that did not cross (a `.env`), so pass
it only when the user asks for their copy to be removed.

With several machines the command stops and lists them. Ask the user which
one they are on. `sm devices` says why a machine can't take part.

When done, `sm worktrees unmirror [<name>]` removes the copy and never the
original. It refuses until both sides hold the same commits. Pass `-f` only
when the user says the copy can go.

Exit 3 means the worktree landed but something after it didn't. Pass the
lines marked `!` on to the user and do not retry.
