# Lab

Testing by hand, on the real UI, by an agent or a person. The
programmatic checks (the proofs, run by `pnpm test` and lefthook) are
in `../test`.

These pages describe what you can do, not what you must. Pick what
the change calls for, check what it touches, and skip the rest. The
one part to keep as written is "Sharing the machine".

Commands and paths are relative to `app/`. The repo root's
`package.json` forwards the scripts named here.

| Page | Reach for it to |
| --- | --- |
| [`fake-host/README.md`](fake-host/README.md) | See a screen in any state (a peer offline, a failing PR, the phone layout) or watch a flow play out, in a browser, with no hub, account or second machine |
| [`scenes/`](scenes/index.ts) | Draw the app's views over the fixtures, with no app behind them: what the marketing site renders and `pnpm test scenes` proves. `/scenes.html` on the desktop fake host's port lists them and draws one |
| [`devices.md`](devices.md) | Check the real thing: dev apps as devices on this machine, moving and mirroring worktrees between them for real |
| [`bridge.md`](bridge.md) | Ask a device window what it knows (`window.api`), or run the same verbs from the CLI |
| [`dev-app.md`](dev-app.md) | Look up how the dev app is built, where it keeps its state, and how dev profiles work |
| [`weblab.md`](weblab.md) | Know what weblab can do (read, click, ask, capture, film) and how it starts and stops things here |

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
