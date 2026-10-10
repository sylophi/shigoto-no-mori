# Reliability

`pnpm reliability` runs every client (the web client, the desktop
app, a device on the tunnel, the terminal) through what breaks
connections in real use, against the dev hub, and reports whether each
recovered on its own, how long it took, and the trace it left. Looped
for hours it is the soak (step 7 of `V3.md`, the reliability pass).

```sh
pnpm reliability                            # every scenario once, every client
pnpm reliability --scenarios laptop-sleep   # some, by name
pnpm reliability --clients desktop,terminal # some clients
pnpm reliability --soak 4h                  # random order and gaps, for 4 hours
```

| Flag | Effect |
| --- | --- |
| `--clients a,b` | Which clients run: `web`, `desktop`, `tunnel`, `terminal` (default all). `terminal` brings the desktop device without its windows. |
| `--scenarios a,b` | Run these, in this order. |
| `--soak <d>` | Loop the soak's scenarios for `<d>` (`90m`, `4h`), in random order, with a random gap between them. |
| `--gap <min>-<max>` | The soak's gap, default `30s-3m`. |
| `--seed <n>` | Replay a soak's order and gaps (the report names its seed). |
| `--headed` | Show the browser, for watching or for signing it in. |
| `--keep` | Leave the profiles and their devices enrolled, for a quicker next run. |
| `--deploy-local-hub` | Let `hub-redeploy` deploy this checkout's `hub/` when it differs from `origin/release/v3`. |

## What it sets up

The host (B) is a remote machine every client reaches. The clients are
this laptop: their network is what goes down, and their machine is what
sleeps.

- **The host (B)**: the dev app as the profile `<worktree>-host`
  (`../dev-app.md`), seeded with one repo, signed in with
  `--clone-login` (the plain dev app must be signed in), admitting the
  web client's origin and accepting the desktop device's commands. It
  advertises its direct listener on a port of the harness's
  (`SHIGOMORI_DIRECT_FRONT_PORT`), where a TCP front passes every
  connection on to the listener, LAN candidates and the tunnel's
  connector alike. Every client's device link to B rides through it.
- **The web client** (`pnpm web:dev` on this worktree's `WEB_PORT`),
  unless it already answers, and **a browser**: the system Chrome with
  a profile of its own (`~/.smd-profiles/<worktree>-browser`) and a tab
  on the web client, reaching B through the dev hub over B's tunnel.
  Its traffic goes through a CONNECT proxy the harness owns: Chrome's
  offline emulation leaves an open socket untouched.
- **The desktop device (A)**: the profile `<worktree>-desk`, a clone of
  B's repo, with two windows. Its hub is a local front the harness
  owns (`SM_DEVICE_HUB_URL`), forwarding to the dev hub, and it reaches
  B over the LAN. It launches first: the first window of a worktree
  serves the renderer the others load, and B must be free to quit.
- **The device on the tunnel (C)**: the profile `<worktree>-tunnel`,
  one window, its hub behind the same front, dialing B's tunnel only
  (`SHIGOMORI_DIAL_KINDS=tunnel`), as a device on another network does.
- **The terminal**: `smd` against A's data dir, whose cross-device verbs
  ride A's link to B.

The clients' network (`networkSwitch.mts`) is the browser's proxy, the
hub front and B's listener front, thrown together, plus the pages'
offline emulation. Down, new connections are refused and open ones
stall. Back up, the stalled flows resume or are cut.

The browser profile keeps its sign-in between runs. The first run
needs one: run with `--headed` and sign in with GitHub, or set
`RELIABILITY_SIGN_IN` to a command that completes the sign-in's GitHub
authorize URL (handed to it as `$AUTH_URL`) and prints the URL GitHub
redirects to, which the tab then opens.

At the end it signs every device out (revoking them) and deletes the
profiles, unless `--keep`. The browser profile stays, and enrolls
again on the next run.

## The scenarios

| Name | What happens | Bound |
| --- | --- | --- |
| `network-drop` | The clients' network goes for 20 to 60 s (flows stall, new ones are refused, the pages report offline) and comes back changed: the stalled flows are cut. The terminal runs `devices`, `list --remote` and a `send` meanwhile. | 30 s |
| `network-blip` | Every flow stalls for 5 to 15 s and resumes, with no offline event. | 30 s |
| `hub-redeploy` | The dev hub is deployed again from this checkout, which restarts its Durable Objects and drops every socket. Skipped when this checkout's hub differs from `origin/release/v3`. | 60 s |
| `host-kill` | B's host process is killed, and its shell forks it again. | 60 s |
| `app-relaunch` | B's whole dev app quits and launches again. | 60 s from the relaunch |
| `laptop-sleep` | The clients' machine sleeps for 30 to 120 s (past a hub ticket's 60 s life about half the time): every tab hidden and frozen, A and C stopped (SIGSTOP), the network gone. Then the network comes back changed, the apps go on (SIGCONT), and the tabs wake. | 30 s |
| `host-sleep` | B's machine sleeps for 30 to 120 s: its whole app stopped, cloudflared and all, its sockets silent but open. Every page must stop reading B as Connected, the terminal runs its verbs meanwhile, and all find B again once it goes on. | 60 s |
| `desk-host-kill` | A's own host process is killed. Its windows and the terminal have to find it once its shell forks it again. | 30 s |
| `reload-and-second-tab` | The tab is reloaded, a second tab of the profile opened, then closed, each step recovering. | 30 s each |
| `reload-and-third-window` | A's first window is reloaded, a third window opened (New Window), then closed, each step recovering. | 30 s each |
| `two-tabs-redial` | A second tab is opened and both tabs' flows are cut at once, three times, so both dial the host together; each tab recovers each time. A host minting a device's direct tickets as one set refuses one of the two, which has to ask again. | 30 s each |
| `token-expiry` | Every tab sleeps (hidden and frozen) and every window goes offline, the network gone for 75 s, past the Clerk session token's and a hub ticket's minute. They wake on a changed network and dial everything again, then each page mints a fresh Clerk token and reads the device list. Real time passes rather than the page's clock moving, which would skew the page against every other device. The hub credential itself never expires. | 30 s |
| `clock-skew` | Every page's clock runs two hours ahead of the other devices' and every flow is cut, so each connection is dialed again on the skewed clock. Then the pages reload, which puts their clocks right, and recover again. Not in the soak until a skewed device connects (V3.md). | 30 s each |
| `sign-out-with-sibling` | A second tab is opened, and the first signs out of the account while the browser's Clerk session stays (what the Sign out button does when the tab's Clerk holds no session): both read signed out within the bound and stay so, nothing enrolls again, and the host no longer lists the browser. Leaves the profile signed out, so it runs only when named, and last. | 20 s |

A scenario runs only when a client it acts on runs. Every scenario
changes B's worktrees (`smd`, against B's data dir) while the clients
are cut off.

A page (a tab, or A's or C's window) has recovered when its hub socket
is connected, its session to B up, B's device chip reads Connected, and
B's worktrees as listed through the hub and as drawn in the sidebar
both match what B itself says (a window's sidebar is narrowed to B
first, since it lists every device on the account). The terminal has
when `smd --json devices` names B with nothing blocking it and
`smd --json worktrees list --remote --from <B>` lists what B says, both
exiting 0. After each recovery it sends a worktree to B and brings it
back (`--source teardown`), both exiting 0. While B is out of reach,
each of its verbs has to end within 60 s, a refusal exiting non-zero in
words (no silence, no stack trace), and a failed send has to leave the
worktree on A.

A run also fails on an uncaught error in a page, and on a page whose
requests failed while it logged nothing about its connection.

What the scenarios cannot do: a desktop app's own processes get no
online or offline signal from the OS (the network is cut at the
proxies, not the interface), and SIGSTOP stops a process's monotonic
and wall clocks alike, where a real sleep stops only the first.

## The report

`report/report.md` (gitignored), rewritten after every scenario so a
soak cut short keeps what it had: a table per scenario (runs,
recoveries, median and longest recovery, the bound), then each run with
its trace: the harness's steps, every page's console (the web client's
`[hub]` and `[direct]` lines, toasts, failed requests), each terminal
run with its exit and first line, and each device's `main.log` with
every span its shell or host ended in failure (`trace.log`,
`host-trace.log`), in time order (sources `host` for B, `A`, `C`). `report.json` has the same outcomes, and a
failure leaves a screenshot of each page beside them.
