# Lab

Testing by hand, on the real UI, by an agent or a person.

These pages describe what you can do, not what you must. Pick what
the change calls for, check what it touches, and skip the rest. The
one part to keep as written is "Sharing the machine".

Commands and paths are relative to `app/`.

On Linux, weblab's browser runs headless, and Google Chrome has to be
installed. That is all the fake host, the scenes and `scenes:compare`
need, so they work there as written. Device windows run there too,
signed out (`devices.md`), so what needs the account, `reliability/`
among it, needs a Mac, as do `relaunch.mts`, `guide-eval/` and
`release.md`, which drive macOS itself.

| Page | Reach for it to |
| --- | --- |
| [`fake-host/README.md`](fake-host/README.md) | See a screen in any state (a peer offline, a failing PR, the phone layout) or watch a flow play out, in a browser, with no hub, account or second machine |
| [`scenes`](../../packages/ui/src/scenes/index.ts) | Draw the app's views over the fixtures, with no app behind them: what the marketing site renders. They and the fixtures live in `packages/ui`; `/scenes.html` on the desktop fake host's port lists them and draws one |
| [`scene-compare/README.md`](scene-compare/README.md) | See what a change does to the look: every scene in both themes against a base ref, with a report of the pairs that differ (`pnpm scenes:compare`) |
| [`guide-eval/README.md`](guide-eval/README.md) | See how the guide answers a new user's how-tos, through Claude Code and Codex (`pnpm guide-eval`) |
| [`reliability/README.md`](reliability/README.md) | Prove every client (the web client, the desktop app's windows, a device on the tunnel, the terminal) recovers on its own: the network dropped, the hub redeployed (when named), the host killed or asleep, the laptop asleep, a tab or window reloaded, a token expired, scripted against the dev hub with a report (`pnpm reliability`), once or as a soak for hours |
| [`devices.md`](devices.md) | Check the real thing: dev apps as devices on this machine, moving and mirroring worktrees between them for real |
| [`bridge.md`](bridge.md) | Ask a device window what it knows (its page api), or run the same verbs from the CLI |
| [`dev-app.md`](dev-app.md) | Look up how the dev app is built, where it keeps its state, and how dev profiles work |
| [`relaunch.mts`](relaunch.mts) | Prove a packaged build's relaunch (a data-folder move, a nuke) leaves a live window: `node lab/relaunch.mts "<path to the .app>"` on a build from `SM_FLAVOR=lab pnpm package`, which shares nothing with the installed app, then that build's `smlab nuke --yes --keep-app` (`dev-app.md`, "Packaged build, as a test flavor"). It reads the window through macOS accessibility, which the terminal running it must be allowed |
| [`release.md`](release.md) | Cut a prerelease: the gates the tip passes before its tag (a packaged lab build, the installed prerelease taking it through "Restart to update") |
| [`cutover.md`](cutover.md) | Release 3.0 to production (the hub, the web client and every app move together), and go back to 2.x from a backup |
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
- **Debugging ports are examples.** Use any free ones, the same in a
  session's `attach`, `address` and `start`.
- **Give the fake host this worktree's port.** Each worktree has its
  own ports in `.env.ports` (port-pool). weblab uses whatever already
  answers at an address, so a session pointed at another worktree's
  port would be looking at that worktree's code.
- **Revoke what you enrolled.** Every device window enrolls a device on
  the dev hub, and ending it does not unenroll it (`devices.md`,
  "Cleaning up").
