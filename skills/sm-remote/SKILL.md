---
name: sm-remote
description: "Move or mirror a Shigoto no Mori (sm) worktree between the user's machines, or set up a project from one machine on another."
---

The app must be open and signed in on both machines. If a command says
it isn't running, open it with `sm app`. On Windows, ask the user to
open it from the Start menu. On a Linux machine, where it runs with no
window, use `sm service start`. Retry once `sm devices` shows the
other machine as ready, or as connected when run outside a project.
A Linux machine signs in with `sm login`, which prints a link and a
code: pass both on, since it waits for the user to approve them.

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

`cd` to the path it prints. If either machine refuses, pass on what it
says: it names the switch to turn on, and on which machine.

## Set up a project on another machine

For "set up <project> here" on a new machine:

```sh
sm projects clone <project> --from <device>
```

For "set up <project> on <device>" from the machine that has it:

```sh
sm projects clone <project> --to <device>
```

It clones the repo from the machine that has it, with its settings and
the files listed in its carry-over. With `--from`, passing an unknown
project name lists the projects available on that device. Tell them the
path it prints.

## Stop mirroring

```sh
sm worktrees unmirror
```

It removes the copy, never the original (if a copy-removal caveat leaves
the copy behind, the mirror still stops and exits with code 3). Pass
`-f` only when the user says the copy can go.

## Notes

- With several machines, ask the user which one they're on.
- `mirror`, `send`, `bring`, and `projects clone` wait until the
  worktree or the repo finishes transferring, as long as that takes, so
  run them where a long command won't time out. If interrupted before
  the worktree lands, `mirror`, `send`, or `bring` cancels and removes
  its copy, though any repo it cloned on the other machine stays.
- `send` and `bring` move a worktree once instead of mirroring it. Use
  them only when asked, and pass `--source teardown` (which deletes the
  original) only when the user asks for it.
- Exit code 3 means the operation completed with caveats (for example, a
  carry-over conflict or a later step that did not finish). Pass the
  lines marked `!` on to the user, and don't retry.
