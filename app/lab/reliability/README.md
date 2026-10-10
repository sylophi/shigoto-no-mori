# Reliability

`pnpm reliability` runs the web client through what breaks connections
in real use, against the dev hub, and reports whether each tab
recovered on its own, how long it took, and the trace it left. Looped
for hours it is the soak (step 7 of `V3.md`, the reliability pass).

```sh
pnpm reliability                          # every scenario once
pnpm reliability --scenarios tab-sleep    # some, by name
pnpm reliability --soak 4h                # random order and gaps, for 4 hours
```

| Flag | Effect |
| --- | --- |
| `--scenarios a,b` | Run these, in this order. |
| `--soak <d>` | Loop the soak's scenarios for `<d>` (`90m`, `4h`), in random order, with a random gap between them. |
| `--gap <min>-<max>` | The soak's gap, default `30s-3m`. |
| `--seed <n>` | Replay a soak's order and gaps (the report names its seed). |
| `--headed` | Show the browser, for watching or for signing it in. |
| `--keep` | Leave the host profile and both devices enrolled, for a quicker next run. |
| `--deploy-local-hub` | Let `hub-redeploy` deploy this checkout's `hub/` when it differs from `origin/release/v3`. |

## What it sets up

- **The web client** (`pnpm web:dev` on this worktree's `WEB_PORT`),
  unless it already answers.
- **A host**: the dev app as the profile `<worktree>-host`
  (`../dev-app.md`), seeded with one repo, signed in with
  `--clone-login` (the plain dev app must be signed in) and admitting
  the web client's origin. The web client reaches it through the dev
  hub over its tunnel, as a browser does.
- **A browser**: the system Chrome with a profile of its own
  (`~/.smd-profiles/<worktree>-browser`) and a tab on the web client.
  Its traffic goes through a proxy the harness owns
  (`networkSwitch.mts`), which is how the network is dropped: Chrome's
  offline emulation leaves an open socket untouched.

The browser profile keeps its sign-in between runs. The first run
needs one: run with `--headed` and sign in with GitHub, or set
`RELIABILITY_SIGN_IN` to a command that completes the sign-in's GitHub
authorize URL (handed to it as `$AUTH_URL`) and prints the URL GitHub
redirects to, which the tab then opens.

At the end it signs both devices out (revoking them) and deletes the
host profile, unless `--keep`. The browser profile stays, and enrolls
again on the next run.

## The scenarios

| Name | What happens | Bound |
| --- | --- | --- |
| `network-drop` | The network goes for 20 to 60 s (flows stall, new ones are refused, the browser reports offline) and comes back changed: the stalled flows are cut. | 30 s |
| `network-blip` | Every flow stalls for 5 to 15 s and resumes, with no offline event. | 30 s |
| `hub-redeploy` | The dev hub is deployed again from this checkout, which restarts its Durable Objects and drops every socket. Skipped when this checkout's hub differs from `origin/release/v3`. | 60 s |
| `host-kill` | The host's process is killed; the dev app's shell forks it again. | 60 s |
| `app-relaunch` | The whole dev app quits and launches again. | 60 s from the relaunch |
| `tab-sleep` | Every tab is hidden and frozen and the network goes, for 30 to 120 s (past a hub ticket's 60 s life about half the time), then wakes on a changed network. | 30 s |
| `reload-and-second-tab` | The tab is reloaded, a second tab of the profile opened, then closed, each step recovering. | 30 s each |
| `two-tabs-redial` | A second tab is opened and both tabs' flows are cut at once, three times, so both dial the host together; each tab recovers each time. A host minting a device's direct tickets as one set refuses one of the two, which has to ask again. | 30 s each |
| `token-expiry` | Every tab sleeps (hidden and frozen) with the network gone for 75 s, past the Clerk session token's and a hub ticket's minute, then wakes on a changed network and dials everything again; each tab then mints a fresh Clerk token and reads the device list. Real time passes rather than the page's clock moving, which would skew the tab against every other device. The hub credential itself never expires. | 30 s |
| `sign-out-with-sibling` | A second tab is opened, and the first signs out of the account while the browser's Clerk session stays (what the Sign out button does when the tab's Clerk holds no session): both read signed out within the bound and stay so, nothing enrolls again, and the host no longer lists the browser. Leaves the profile signed out, so it runs only when named, and last. | 20 s |

Every scenario changes the host's worktrees (`smd`, against the host
profile's data dir) while the tab is cut off. A tab has recovered when
its hub socket is connected, its session to the host up, the host's
device chip reads Connected, and the host's worktrees as listed through
the hub and as drawn in the sidebar both match what the host itself
says. A run also fails on an uncaught error in a page, and on a tab
whose requests failed while it logged nothing about its connection.

## The report

`report/report.md` (gitignored), rewritten after every scenario so a
soak cut short keeps what it had: a table per scenario (runs,
recoveries, median and longest recovery, the bound), then each run with
its trace: the harness's steps, every tab's console (the web client's
`[hub]` and `[direct]` lines, toasts, failed requests) and the host's
`main.log`, in time order. `report.json` has the same outcomes, and a
failure leaves a screenshot of each tab beside them.
