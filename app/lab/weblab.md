# weblab in the lab

Everything that drives a page or a window goes through [weblab](https://github.com/dittofleet/weblab), an MCP server: `new` opens a session (either a browser of its own or an attached window), `run` executes steps on it, and `end` closes it. Its `docs` tool is the full reference. What it gives you here:

- **Reading.** `look` returns the page's accessibility tree with refs you can act on, or just its text. Each reply also reports where the page is and what it logged (console errors and failed requests) since the last reply.
- **Acting like a person.** `click`, `fill`, `press`, `hover`, `drag`, `select`, and `upload` target elements by role and name, label, text, or a ref from `look`.
- **Asking the app.** A `js` step runs inside the page and awaits what it returns, such as a bridge call, store state, or a layout measurement.
- **Waiting on outcomes.** `expect` retries until text appears, an element appears or disappears, or an expression becomes true.
- **Capturing.** `shot` returns a screenshot inline (the viewport, the full page, or one element). `matches` compares it against an earlier shot and marks what differs for before-and-after checks. A session opened with `video` records until it ends, drawing a cursor on every click.
- **Several at once.** Open any number of named sessions and target another session in a step using `on`: two devices in one run, desktop beside phone, light beside dark, or one checkout beside another.
- **Conditions.** `viewport` and `colorScheme` switch without reloading. `cdp` steps throttle or cut the network, slow the CPU, and emulate vision deficiencies. `playwright` steps control the clock, go offline, and do whatever else Playwright can.
- **Diagnosis.** A failed step returns a screenshot from that moment along with console output since the last reply, and leaves the session open on that page for inspection. Passing `trace: "on-failure"` saves a full Playwright trace.
- **Code.** Use a `playwright` step, or pass a code file (`run` with `file`), when inline steps are not enough (such as looping over every pose).

## In this repo

- **Where it starts things.** A session's `start` command runs in its project directory, resolved as the nearest `package.json` at or above `dir`. Because `dir` defaults to where weblab was started (normally the checkout root), `pnpm fake-host` and `pnpm device` work as written. If weblab was started elsewhere, set `dir` to the checkout.
- **What it owns.** When nothing answers at a session's address, weblab runs `start` and stops it when the last session at that address ends. This covers both the fake host's Vite server and device windows, so `end` handles cleanup. Calling `end` with no session name ends everything.
- **Where files go.** Screenshots, videos, traces, logs, and the output of processes weblab started go to its files directory, named in every reply, so nothing lands in the repo. Because weblab's browser runs on this machine, it can reach the dev servers here even when the person watching is remote.
- **Focus is emulated.** An attached window reports `document.hasFocus()` as true even behind another app. As a result, a reload under weblab starts out reading as focused and keeps animations that `.unfocused` pauses running until you focus and unfocus the window: run `open -b <its bundle id>` (the `CFBundleIdentifier` of `.electron-dev/dist/Electron.app`), then `open -a Finder`.
- **A grabbed window's idle cost.** React Grab (⌘⇧G) pauses every running animation while freezing the page and resumes them with `play()`, after which CSS can no longer pause them. That leaves the wallpaper drifting behind other windows at about 5% of a core plus its GPU share. Reload any window where React Grab ran before measuring its idle cost.
- **Dev noise.** A dev window logs the same lines on every boot. Pass this `ignore` list to keep them out of replies:
  `["\\[vite\\]", "ws://localhost", "Electron Security Warning", "clerk-telemetry", "development keys", "React DevTools"]`.
