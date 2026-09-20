---
name: sm-share-worktree
description: Move or mirror a Shigoto no Mori worktree between the user's devices. Use when the user asks to send, mirror, or share a worktree to their machine so they can test it, or to take over, bring, or continue work they did on another machine.
---

The user has the app on several machines, and you are on one of them. There
are two ideas, each with a direction:

```sh
sm worktrees mirror [<name>] --to <device>      # a live copy of yours, on their machine
sm worktrees mirror <worktree> --from <device>  # a live copy of theirs, here
sm worktrees send   [<name>] --to <device>      # move yours to their machine
sm worktrees bring  <worktree> --from <device>  # move theirs here
```

A mirror keeps both copies in step until you stop it. A move happens once.
All of it runs inside the app on this machine, so the app has to be open and
signed in, here and on the other machine. Each command prints the copy's path.

**"Send it to me", "let me test this on my machine": mirror it to them.**

```sh
sm worktrees mirror
```

The worktree you are in lands on their machine with its branch, its
uncommitted changes and its ignored files. From then on what you commit or
edit shows up there, and what they fix there shows up here. Tell them the
path. Asking again changes nothing and says it is already mirrored.

**"Take over what I did locally", "continue my work from my laptop": mirror it from them.**

```sh
sm worktrees list --remote                        # their worktrees of this repo
sm worktrees mirror <name-or-branch> --from <device>
```

Run it from any checkout of the same repo. It makes a new worktree here, so
`cd` to the path it prints before doing anything else. Their original stays
where it is and follows your work, so they can test at any point without
asking for it back.

Use `bring` in its place only when they want the work off their machine for
good, and then decide what happens to their copy: `--source shelve` hides it,
`--source teardown` removes it once the copy here holds its commits and
uncommitted changes. Teardown also deletes any ignored files (a `.env`, local
databases) that the leave-out rule kept from crossing, so use it only when
they ask for their copy to be removed. With neither, their copy keeps the
branch checked out, and sending the work back later is refused.

## Which machine

With one other machine that qualifies, `--to` can be left off. With several
the command stops and lists them: ask the user which one they are on. Do not
guess. `sm devices` shows each machine and why one can't take part:

- **not connected**: the app isn't open there, or it is offline.
- **no checkout of this repo**: they need to add the project there first.
- **doesn't accept commands**: a switch on that machine's Devices page,
  which only they can turn on.

## When you are done

```sh
sm worktrees mirrors           # what is mirrored, and whether git is synced
sm worktrees unmirror [<name>]
```

Stopping removes the copy (theirs for `--to`, the one here for `--from`) and
never the original. It refuses until both sides hold the same commits. `-f`
overrides that, so use it only when the user says the copy can go. A mirror is
not a backup of the branch: push as usual.

## Failure cases

- **"The app isn't running"**: nothing was changed. Open it yourself with
  `sm app`, give it a few seconds to reach the other machines, and check
  `sm devices` until the one you need says ready. If it comes up signed
  out, stop and tell the user: you cannot sign in for them.
- **The branch or folder name is already taken there**: that machine
  already has this work checked out. If it is a leftover copy, they remove
  it there. There is no rename.
- **Exit 3**: the worktree landed, but something after it didn't hold (the
  uncommitted changes, the ignored files, or the original's fate). Read the
  lines marked `!` and pass them on. Do not retry.
- **Interrupted**: a transfer that started finishes in the app anyway.
  Check `sm worktrees mirrors` or the other machine before running it again.
