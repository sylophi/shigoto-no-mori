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
| [`devices.md`](devices.md) | The real app as several devices on this machine: the hub, transfers, mirrors and the CLI, for real |
| [`remote.md`](remote.md) | What each remote feature should do, for checking a change against |

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

## weblab

Everything that drives a page or a window goes through
[weblab](https://github.com/dittofleet/weblab), an MCP server: `new`
opens a session (a browser of its own, or an attached window), `run`
runs steps on it, `end` closes it. Its `docs` tool is the full
reference. What it gives you here:

- **Reading.** `look` gives the page's accessibility tree, with refs
  to act on, or just its text. Each reply also says where the page is
  and what it logged (console errors, failed requests) since the last.
- **Acting like a person.** `click`, `fill`, `press`, `hover`, `drag`,
  `select`, `upload`, by role and name, label, text or ref, so a step
  reads the way the UI does.
- **Asking the app.** A `js` step runs in the page and awaits what it
  returns: a bridge call, a store's state, a layout measurement.
- **Waiting on outcomes.** `expect` retries until text shows, an
  element appears or goes, or an expression turns true.
- **Capturing.** `shot` returns a screenshot inline (the viewport, the
  full page or one element). `matches` holds it to an earlier shot
  and marks what differs, for before-and-after. A session opened with
  `video` records until it ends, with a drawn cursor on each click.
- **Several at once.** Any number of named sessions, and a step can
  address another with `on`: two devices in one run, desktop beside
  phone, light beside dark, one checkout beside another.
- **Conditions.** `viewport` and `colorScheme` switch without a
  reload. `cdp` steps throttle or cut the network, slow the CPU,
  emulate vision deficiencies. `playwright` steps control the clock,
  go offline, and reach anything else Playwright does.
- **Diagnosis.** A failed step comes with a screenshot of the moment
  and the console since. The session stays open at that page to
  inspect. `trace: "on-failure"` keeps a full Playwright trace.
- **Code when steps run out.** A `playwright` step, or a code file
  (`run` with `file`) for loops, helpers and Node: walking every pose
  and shooting each, say.

What is particular to this repo:

- **Where it starts things.** A session's `start` runs in its project,
  the nearest `package.json` at or above `dir`. `dir` defaults to
  where weblab was started, normally the checkout's root, so
  `pnpm fake-host` and `pnpm device` work as written. A weblab started
  anywhere else needs `dir` set to the checkout.
- **What it owns.** When nothing answers at a session's address,
  weblab runs its `start`, and stops it when the last session there
  ends. That covers the fake host's vite server and the device windows
  alike, so `end` is the cleanup, and `end` with no session named ends
  everything.
- **Where files go.** Screenshots, videos, traces, logs and the output
  of what weblab started go to its files directory, named in every
  reply. Nothing lands in the repo. Its browser runs on this machine,
  so it reaches the dev servers here when the person watching is
  remote.
- **Dev noise.** A dev window logs the same lines on every boot. This
  `ignore` keeps them out of the replies:
  `["React Grab", "\\[vite\\]", "ws://localhost", "Electron Security Warning", "clerk-telemetry", "development keys", "React DevTools"]`.

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
