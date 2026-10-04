# Lab

Testing by hand, on the real UI, by an agent or a person. The
programmatic checks (the proofs, run by `pnpm test` and lefthook) are
in `../test`.

These pages describe what you can do, not what you must. Pick what
the change calls for, check what it touches, and skip the rest. The
one part to keep as written is "Sharing the machine".

Commands and paths are relative to `app/`. The repo root's
`package.json` forwards the scripts named here.

| Page | What it covers |
| --- | --- |
| [`fake-host/README.md`](fake-host/README.md) | The real UI over a fake backend: any screen in any state, in a browser, with no hub, account or second machine |
| [`devices.md`](devices.md) | The real app as several devices on this machine: launching them, what to exercise, cleaning up |
| [`bridge.md`](bridge.md) | What a device window can be asked through `window.api`, and the same verbs from the CLI |
| [`dev-app.md`](dev-app.md) | The dev app itself: builds, data folders, environment, dev profiles and their rules |
| [`weblab.md`](weblab.md) | What weblab gives you, and how it starts, shares and stops things in this repo |

## What you can test

- **How a screen looks in a given state.** A peer offline, a failing
  pull request, a crowded forest, an update waiting, a villager's
  birthday: the fake host poses each from the URL. Light and dark,
  doubutsu, the phone layout, side by side if you like.
- **How a flow plays out in the UI.** The fake host's sync verbs
  change its fake world, so a transplant or a mirror shows its steps
  and its outcome, posed. Good for dialogs, progress and empty states.
- **That the real thing works.** Device windows are real dev apps,
  each its own device on the dev hub. Moves, mirrors, refusals, the
  CLI's cross-device verbs, presence and reconnects happen for real
  between them.
- **What a person would see, and what the app knows.** Every window
  can be read as a person reads it (a `look`) and asked directly
  through its bridge (`window.api` on a device, `window.fakeHost` on
  the fake host).
- **A record of it.** Screenshots come back in weblab's replies, and a
  session can be filmed, the fake host and real windows alike.

## Sharing the machine

Other sessions (agents in other worktrees, the owner) may be testing
at the same time. Profiles, debugging ports and the account's device
list are shared by the whole machine, not per worktree.

- **Put a session tag in every profile name**: `<tag>-a`, not `a`. The
  worktree folder name works. A device's name ends in `[<profile>]`,
  so this keeps device names apart too. Two sessions on one profile
  name share its folders, and `--fresh` wipes them under the other.
- **Touch only what carries your tag**: profiles, devices, and
  processes (match on your worktree path, never on `Electron`). An
  unknown device on the account may be another session's live test.
- **Debugging ports are examples.** Use any free ones.
- **Give the fake host this worktree's port.** Each worktree has its
  own ports in `.env.ports` (port-pool). weblab uses whatever already
  answers at an address, so a session pointed at another worktree's
  port would be looking at that worktree's code.
- **Revoke what you enrolled.** Every device window enrolls a device on
  the dev hub, and ending it does not unenroll it (`devices.md`,
  "Cleaning up").
