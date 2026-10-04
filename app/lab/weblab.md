# weblab in the lab

Everything that drives a page or a window goes through
[weblab](https://github.com/dittofleet/weblab), an MCP server: `new`
opens a session (a browser of its own, or an attached window), `run`
runs steps on it, `end` closes it. Its `docs` tool is the full
reference. What it gives you here:

- **Reading.** `look` gives the page's accessibility tree, with refs
  to act on, or just its text. Each reply also says where the page is
  and what it logged (console errors, failed requests) since the last.
- **Acting like a person.** `click`, `fill`, `press`, `hover`, `drag`,
  `select`, `upload`, by role and name, label, text, or a ref from a
  `look`.
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
  go offline, and do whatever else Playwright can.
- **Diagnosis.** A failed step comes with a screenshot of the moment
  and the console since. The session stays open at that page to
  inspect. `trace: "on-failure"` keeps a full Playwright trace.
- **Code.** A `playwright` step, or a code file (`run` with `file`)
  when steps are not enough, such as a loop over every pose.

## In this repo

- **Where it starts things.** A session's `start` runs in its project,
  the nearest `package.json` at or above `dir`. `dir` defaults to
  where weblab was started, normally the checkout's root, so
  `pnpm fake-host` and `pnpm device` work as written. A weblab started
  anywhere else needs `dir` set to the checkout.
- **What it owns.** When nothing answers at a session's address,
  weblab runs its `start`, and stops it when the last session there
  ends. That covers the fake host's vite server and the device windows
  alike, so `end` is the cleanup, and `end` with no session named ends
  everything. When `end` leaves a server running for another session,
  that session may be another agent's, in a weblab of its own that
  `list` does not show. Leave the server alone: the last session
  stops it.
- **Where files go.** Screenshots, videos, traces, logs and the output
  of what weblab started go to its files directory, named in every
  reply. Nothing lands in the repo. Its browser runs on this machine,
  so it reaches the dev servers here when the person watching is
  remote.
- **Dev noise.** A dev window logs the same lines on every boot. This
  `ignore` keeps them out of the replies:
  `["React Grab", "\\[vite\\]", "ws://localhost", "Electron Security Warning", "clerk-telemetry", "development keys", "React DevTools"]`.
