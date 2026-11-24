# Reliability

`pnpm reliability` drives every client (the web client, the desktop app, a device on the tunnel, and the terminal) through real-world connection disruptions against the Colibrii instance named in `.env.local`. It reports whether each client recovered on its own, how long recovery took, and the trace it produced. Looped for hours, it serves as the soak test.

```sh
pnpm reliability                            # every scenario once, every client
pnpm reliability --scenarios laptop-sleep   # some, by name
pnpm reliability --clients desktop,terminal # some clients
pnpm reliability --soak 4h                  # random order and gaps, for 4 hours
```

| Flag | Effect |
| --- | --- |
| `--clients a,b` | Which clients to run: `web`, `desktop`, `tunnel`, `terminal` (default all). `terminal` starts the desktop device without opening its windows. |
| `--scenarios a,b` | Run these scenarios in this order. `hub-redeploy` and `sign-out-with-sibling` run only when explicitly named. `hub-redeploy` deploys the Colibrii service at `COLIBRII_SERVICE_DIR`. |
| `--soak <d>` | Loop the soak scenarios for duration `<d>` (`90m`, `4h`) in random order, with a random gap between them. |
| `--gap <min>-<max>` | Gap range between soak scenarios, default `30s-3m`. |
| `--seed <n>` | Replay a soak's order and gaps (the report prints its seed). |
| `--headed` | Show the browser window so you can watch. |
| `--keep` | Keep every profile and its device enrollment for a faster next run. |
| `--revoke-host` | Sign B out at the end and delete its profile, which is kept otherwise. `--keep` takes precedence. |

## What it sets up

The host (B) models a remote machine that every client connects to. The clients model this laptop: their network is what goes down, and their machine is what sleeps.

- **The host (B)**: Runs the dev app under profile `<worktree>-host` ([`../dev-app.md`](../dev-app.md)), persisted across runs. On its first run, it seeds one repo, signs in with `--clone-login` (the plain dev app must already be signed in), and waits for its new tunnel to route. It allows the web client's origin and accepts commands from the desktop device. It advertises its direct listener on a harness-owned port (`SHIGOMORI_DIRECT_FRONT_PORT`), where a TCP proxy forwards every connection to the real listener, covering both LAN candidates and the tunnel's connector. Every client's device link to B passes through this proxy.
- **The web client and browser**: Starts `pnpm web:dev` on this worktree's `WEB_PORT` (unless it is already responding) and launches system Chrome with its own profile (`~/.smd-profiles/<worktree>-browser`) and a tab on the web client reaching B over B's tunnel. Browser traffic goes through a harness-owned CONNECT proxy because Chrome's offline emulation leaves already-open sockets untouched.
- **The desktop device (A)**: Runs profile `<worktree>-desk`, with a clone of B's repo and two windows. Its hub points to a harness-owned local proxy (`SM_DEVICE_HUB_URL`) forwarding to the Colibrii instance, and it connects to B over the LAN. A launches first because the first window of a worktree serves the renderer that the other windows load, and B must remain free to quit.
- **The device on the tunnel (C)**: Runs profile `<worktree>-tunnel` with one window, pointing at the same local hub proxy and dialing B over its tunnel only (`SHIGOMORI_DIAL_KINDS=tunnel`), matching a device on another network.
- **The terminal**: Runs `smd` against A's data directory, so its cross-device commands ride A's link to B.

The clients' simulated network ([`networkSwitch.mts`](networkSwitch.mts)) switches the browser's CONNECT proxy, the hub proxy, and B's listener proxy together, along with each page's offline emulation. When switched down, new connections are refused and open connections stall. When switched back up, stalled flows either resume or are cut.

The browser profile keeps its sign-in between runs. If the profile is not signed in, the harness requests a sign-in token from Colibrii using the dev account's stored refresh token ([`../devSignIn.mts`](../devSignIn.mts)), and the browser tab redeems it to sign in.

At the end of a run (unless `--keep` is passed), the harness signs out the browser, A, and C (revoking their devices) and deletes A's and C's profiles. The browser profile stays on disk and enrolls again on the next run. B stays enrolled, along with its profile and tunnel, until a run with `--revoke-host` (or a run where B reads as signed out, so the next run starts B fresh).

An app profile is removed only when the app is running and able to sign itself out. One that is not up keeps its profile so the next run can sign it out. Before deleting the worktree, do a run with `--revoke-host`: an account holds at most 16 devices, after which enrolling a new device replaces the offline device seen longest ago.

## The scenarios

Scenarios are defined in `ALL_SCENARIOS` in [`scenarios.mts`](scenarios.mts), each with what it does and its recovery bound. The report lists the bounds in its summary table and describes each executed scenario under Scenarios.

A scenario runs only when at least one client it acts on is enabled. The outage scenarios modify B's worktrees using `smd` against B's data directory (unlike `sign-out-with-sibling`, which tests sign-out and enrollment without modifying them).

A page (the browser tab, or A's or C's window) counts as recovered when its hub socket is connected, its session to B is up, B's device chip reads Connected, and B's worktrees listed through the hub and drawn in the sidebar both match what B itself reports (a desktop window's sidebar is narrowed to B first, since it otherwise lists every device on the account).

The terminal counts as recovered when `smd --json devices` names B with nothing blocking it and `smd --json worktrees list --remote --from <B>` matches what B reports, with both exiting 0. After each recovery, the harness sends a worktree to B and brings it back (`--source teardown`), requiring both to exit 0. While B is out of reach, each terminal command must finish within 60 s, any refusal must exit non-zero with a readable message (no silence and no stack trace), and a failed send must leave the worktree on A.

A run also fails if a page throws an uncaught error, or if a page's requests fail while it logs nothing about its connection.

What the scenarios cannot test: a desktop app's processes receive no online or offline signal from the OS (because the network is cut at the proxies rather than the network interface), and under SIGSTOP both a process's monotonic and wall clocks keep running, whereas a real system sleep pauses the monotonic clock. As a result, a frozen device never detects a wake event, and after a long freeze B's listener can close a peer's link after 120 s of silence, which a real sleep does not trigger. The peer then redials.

## The report

`report/report.md` (gitignored) is rewritten after every scenario so a soak cut short preserves what it recorded. It contains a summary table with one row per scenario (runs, recoveries, median recovery time, longest recovery time, and the bound), followed by each run's chronological trace:

- the harness's steps
- every page's console output (the web client's `[hub]`, `[peers]`, and `[link]` lines, toasts, and failed requests)
- each terminal command's exit code and first line of output
- each device's `main.log` along with every span its shell or host ended in failure (`trace.log`, `host-trace.log`), in time order (sources `host` for B, `A`, and `C`)

`report.json` stores the same outcomes, and any failure saves a screenshot of each page beside them.
