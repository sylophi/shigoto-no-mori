# Lab

Manual testing on the real UI, by an agent or a person.

These pages describe what you can do, not what you must do. Pick what the change calls for, check what it touches, and skip the rest. The one section to follow as written is "Sharing the machine".

Commands and paths are relative to `app/`.

On Linux, weblab's browser runs headless and requires Google Chrome to be installed. That is all the fake host, the scenes, and `scenes:compare` need, so they work on Linux as written. Device windows ([`devices.md`](devices.md)) and [`reliability/`](reliability/README.md) run on Linux too, with each window on its own virtual display. [`relaunch.mts`](relaunch.mts) and [`release.md`](release.md) drive a packaged Mac build, so they require a Mac.

Any flow that signs in with a link and a code (a host's `login`, a test install's sign-in, or a window's code sign-in) can be approved on any machine with `pnpm sign-in`, which prompts you once.

| Page | Reach for it to |
| --- | --- |
| [`fake-host/README.md`](fake-host/README.md) | See a screen in any state (a peer offline, a failing PR, the phone layout) or watch a flow play out in a browser, without a hub, account, or second machine |
| [`scenes`](../../packages/ui/src/scenes/index.ts) | Render the app's views over the fixtures with no app behind them (the same views the marketing site renders). The scenes and fixtures live in `packages/ui`, and `/scenes.html` on the desktop fake host's port lists them and renders any one of them |
| [`scene-compare/README.md`](scene-compare/README.md) | Check visual changes by comparing every scene in both themes against a base ref, producing a report of the pairs that differ (`pnpm scenes:compare`) |
| [`guide-eval/README.md`](guide-eval/README.md) | Check how the guide answers a new user's how-to questions through Claude Code and Codex (`pnpm guide-eval`) |
| [`reliability/README.md`](reliability/README.md) | Verify that every client (the web client, desktop app windows, a device on the tunnel, and the terminal) recovers on its own from dropped networks, hub redeploys (when named), a killed or sleeping host, a sleeping laptop, reloaded tabs or windows, and expired tokens. It runs scripted against the dev hub with a report (`pnpm reliability`), either once or as a multi-hour soak |
| [`devices.md`](devices.md) | Test the real setup: run dev apps as separate devices on this machine and move or mirror worktrees between them for real |
| [`bridge.md`](bridge.md) | Query a device window through its page API, or run the same verbs from the CLI |
| [`dev-app.md`](dev-app.md) | Look up how the dev app is built, where it stores its state, and how dev profiles work |
| [`relaunch.mts`](relaunch.mts) | Verify that a packaged build's relaunch (after a data-folder move or a nuke) leaves a live window. Run `node lab/relaunch.mts "<path to the .app>"` on a build from `SM_FLAVOR=lab pnpm package` (which shares nothing with the installed app), then clean up with that build's `smlab nuke --yes --keep-app` (see [`dev-app.md`](dev-app.md), "Packaged build, as a test flavor"). It reads the window through macOS Accessibility, so the terminal running it must have Accessibility permission |
| [`sign-in.mts`](sign-in.mts) | Sign a dev or test instance into your account unattended: `pnpm sign-in <link>` approves a link's code, and `pnpm sign-in <command...>` runs a sign-in command (such as `smlab login`) and approves the link it prints. On its first run, it shows its own code for a person to approve once |
| [`release.md`](release.md) | Cut a prerelease: the gates the tip must pass before tagging (a packaged lab build, and updating the installed prerelease through "Restart to update") |
| [`weblab.md`](weblab.md) | See what weblab can do (read, click, query, capture screenshots, record video) and how it starts and stops processes here |

## Sharing the machine

Other sessions (agents in other worktrees, or the owner) may be testing at the same time. Profiles, debugging ports, and the account's device list are shared across the whole machine, not isolated per worktree.

- **Put a session tag in every profile name:** use `<tag>-a`, not `a` (the worktree folder name works). A device's name ends in `[<profile>]`, so tagging keeps device names distinct too. Two sessions using the same profile name share its folders, and `--fresh` wipes those folders out from under the other session.
- **Touch only what carries your tag:** your own profiles, devices, and processes (match processes by your worktree path, never by `Electron`). An unknown device on the account may belong to another session's live test.
- **Treat debugging ports as examples.** Use any free ports, and pass the same port in a session's `attach`, `address`, and `start`.
- **Give the fake host this worktree's port.** Each worktree has its own ports in `.env.ports` (managed by port-pool). weblab connects to whatever is already listening at an address, so pointing a session at another worktree's port will look at that worktree's code instead.
- **Revoke what you enrolled.** Every device window enrolls a device on the dev hub, and ending the window does not unenroll it (see [`devices.md`](devices.md), "Cleaning up").
