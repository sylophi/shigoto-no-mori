# Testing

How to check the app by running it: the proofs, a fake host that
poses any screen in a browser, the real app as several devices on one
machine, and the remote smoke that runs every remote flow end to end.
Written for people and for agents.

Commands and paths are relative to `app/`. `hub/`, `cli/` and
`lefthook.yml` are one level up, at the repo root, whose
`package.json` forwards the scripts named here.

This is a reference, not a checklist. Test what your change touches,
pick your own names and ports, and skip the rest. The one part to keep
as written is "Sharing the machine".

## What to reach for

| To | Use |
| --- | --- |
| Check logic, a contract or a protocol | A proof: `pnpm test <name>` |
| See any screen in any state, screenshot it, record it | The fake host, in a weblab session |
| Try a real flow on one device or several | Device windows, in weblab sessions |
| Run every remote flow end to end | The remote smoke, a weblab code file |

Everything that drives a page or a window goes through
[weblab](https://github.com/dittofleet/weblab), an MCP server: `new`
opens a session, `run` runs steps on it, `end` closes it. Its `docs`
tool is the full reference. What follows is what is particular to this
repo.

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
- **One smoke run at a time.** It uses the fixed profiles `e2e-a` and
  `e2e-b` and wipes them when it starts.

## weblab in this repo

- **Where it starts things.** A session's `start` command runs in its
  project, the nearest `package.json` at or above `dir`. `dir`
  defaults to where weblab itself was started, normally the checkout's
  root, so `pnpm fake-host` and `pnpm device` work as written. A
  weblab started anywhere else needs `dir` set to the checkout.
- **What it owns.** When nothing answers at a session's address,
  weblab runs its `start` and stops it again when the last session
  there ends. That covers the fake host's vite server and the device
  windows alike, so `end` is the cleanup, and `end` with no session
  named ends everything.
- **Where files go.** Screenshots, videos, traces, console and network
  logs, and the output of what weblab started, go to its files
  directory, named in every reply. Nothing lands in the repo. weblab's
  browser runs on this machine, so it reaches the dev servers here
  even when the person watching is remote.
- **Dev noise.** A dev window logs the same lines on every boot. This
  `ignore` keeps them out of the replies:
  `["React Grab", "\\[vite\\]", "ws://localhost", "Electron Security Warning", "clerk-telemetry", "development keys", "React DevTools"]`.

## Proofs

`pnpm test` lists the proofs in this directory, `pnpm test <name>`
runs one, and several names run in order, stopping at a failure. Each
is a standalone script that exits non-zero when it fails, and flags
pass through (`pnpm test socket-host --update`). `lefthook.yml` runs
each on commit, gated to the files it covers, and
`lefthook run pre-commit --all-files` runs the lot. The hub has its
own suite (`hub/`).

## The fake host

The real UI in a browser over a fake `window.api` (`fake-host/`): four
devices with mixed presence, shared and remote-only projects (two of
them terrier-sourced), pull requests in every CI state, villagers. So
every multi-device screen can be posed and captured without a device
hub, a second machine, or Clerk. Dev-only: nothing here ships.

Two flavors, each a vite server on this worktree's port from
`.env.ports` (5191 and 5192 without port-pool):

- **Desktop shell**: `pnpm fake-host` on `FAKE_HOST_PORT`. Mounts the
  desktop renderer (`renderer/App.tsx`), the page posing as "Studio
  Mac" over a local forest.
- **Web shell**: `pnpm fake-host:web` on `FAKE_HOST_WEB_PORT`. Mounts
  the real web boot (`web/boot`). The page poses as an enrolled browser
  device, and every machine forest (Studio Mac included) is a peer.
  Under 768px wide it renders the phone layout.

Open one with weblab's `new`, the worktree's port as the address
(`grep FAKE_HOST_ .env.ports`; 4752 and 4753 below stand for them):

```json
{ "name": "ui", "address": 4752, "start": "pnpm fake-host", "path": "/?theme=dark&to=/devices" }
```

```json
{ "name": "phone", "address": 4753, "start": "pnpm fake-host:web", "path": "/devices?theme=light", "viewport": "390x844@3" }
```

Then pose and capture with `run`: `goto` a new pose, `look` to read
the page with refs to click, `shot` to screenshot it (the image comes
back in the reply), `expect` to wait for what should be on screen
before a shot. A session opened with `"video": true` records until it
ends, with a drawn cursor that glides to each click; set `FFMPEG` for
an mp4 beside the webm. The sync verbs are posed, so a recording shows
the UI of a flow, not a transfer.

```json
{ "session": "ui", "steps": [
  { "goto": "/?theme=light&checks=failing&to=/devices/dev_8f3ac2e1/projects/p_sm/worktrees/wt_sm_hum" },
  { "expect": "happy-hummingbird" },
  { "shot": "checks-failing" }
] }
```

### Poses

Poses ride the URL:

- `?theme=light|dark`, `?doubutsu=0|1`: appearance, seeded pre-paint.
  `?light=<id>` and `?dark=<id>` pick each appearance's doubutsu
  palette (the ids in `shared/themes.ts`, default `cream` and
  `charcoal`).
- `?peers=sm:connected,tp:connected,mini:online,pc:offline`: presence
  per device key (`sm` Studio Mac, `tp` Thinkpad, `mini` Mini, `pc`
  Work PC). The desktop default is `tp:connected`, and the web
  default adds `sm`.
- `?updates=sm,tp,mini`: the devices holding a staged update, by the
  same keys (default `tp`). Every device runs 2.0.3 and the update is
  2.1.0, so the others count as behind it (the update toast, Update
  all).
- `?downloading=sm,tp,mini`: the devices downloading the update.
- `?crowd=<n>`: up to 20 more projects on Studio Mac, most holding
  their primary checkout alone, for the forest at the size where
  finding a project gets hard. Add `&crowdShared=1` to have terrier
  list them all and the Thinkpad hold most of them too, so nearly
  every project is terrier's and on a second device (the open
  project's header shows the paw and its devices).
- `?view=inbox`: open the sidebar in its inbox view (the toggle flips
  it in-session either way).
- `?updatedFrom=<version>`: the build this window last ran, so the fake
  host's own 2.0.3 boots as an update from it and shows the update toast
  (e.g. `?updatedFrom=2.0.1`, whose "What's new" lists 2.0.2 and 2.0.3).
- `?checks=<variant>`: the CI rollup on PR #148 (worktree
  `happy-hummingbird`,
  `?to=/devices/dev_8f3ac2e1/projects/p_sm/worktrees/wt_sm_hum`), with
  the merge state GitHub would pair with it. Variants are the keys of
  `FAKE_CHECK_POSES` in `fake-host/pullRequestFixtures.ts`: `none`,
  `single-passed`, `single-failing`, `passed`, `passed-some-skipped`,
  `all-skipped`, `auto-merge`, `pending`, `failing`, `failing-blocked`,
  `failing-and-pending`, `many`. Absent, it keeps two passing checks.
- Desktop: `?to=/devices` navigates the memory router after mount. Web:
  the path itself is the route (`/devices/...`).
- `?villageLife=1`: Village life on in this window's settings (the
  desktop's: the web shell has none). Off by default, as a fresh
  install has it.
- `?signedOut=1`: the desktop signed out of its account (the account
  status alone: the fixture peers stay), for the settings that need
  one.
- `?today=MM-DD` (or `YYYY-MM-DD`): the calendar day, for a villager's
  birthday (the sidebar cake and the worktree page's party).
- `?villagers=absent|downloading|ready|failed`: the villager data
  status, for the control beside Village life in Settings. The
  default is ready when the fake host holds a download (below), absent
  otherwise.
- `?visits=none`: an empty Visitors album (Settings, with Village
  life on). Without it the album is posed with a spread of visits.

### Controls

Runtime controls on `window.fakeHost`, for a `js` step:
`setPeer(deviceId, "connected" | "online" | "offline")`,
`setSocket(phase)`, `navigate(to)` (desktop, no reload),
`setMirrorConflicts(roots)` (holds those paths still on every mirror
started in this session, for the conflict chip; start one first, since
the fixtures seed none), `worktree(deviceId, "add" | "remove", name,
{ projectId?, changedCount? })` (a worktree made or removed behind the
app's back, the way `sm` or another device would, for the villagers
moving in and out, and with changes to commit), plus
`emitClient`/`emitHost` for raw broadcasts. What the page logs comes
back in each reply.

### Fixtures

Fixtures live in `fake-host/fixtures.ts`. Each device has a small disk
there (`fakeDisks`) for the add-project dialog to browse, and adding or
cloning on one really registers the project, so it folds into the
sidebar the way a real one would. `fake-host/bridge.ts` serves them and
answers any unhandled channel with a schema-derived stub (fabricated
arms allowed: this is a fake, not the fail-closed web bridge). The sync
verbs really mutate the fixture world, so the transplant and mirror
flows show their outcome: a posed mirror session cycles every few
seconds, keeps a history, and folds the peer's sidebar row into the
local one.

The app downloads the villager faces and profiles from Nookipedia when
its user asks. The fake host serves its own copy from
`fake-host/villager-data`, which `pnpm villagers:fetch` downloads with
the app's own downloader (about 4 MB, once, served by
`fake-host/villagerData.ts`). Without it the villager data reads as not
downloaded and no face shows. `/villager-icons.html` on the desktop
shell is a contact sheet of the faces over the same bridge, with
Village life on.

## Device windows

The real app, as many devices as a test needs, each a dev window
weblab starts and attaches to:

```json
{ "name": "a", "attach": "127.0.0.1:9241", "address": "127.0.0.1:9241", "start": "pnpm device <tag>-a --fresh --clone-login", "startTimeout": 240000, "tab": "shigomori-dev://" }
```

```json
{ "name": "b", "attach": "127.0.0.1:9242", "address": "127.0.0.1:9242", "start": "pnpm device <tag>-b --fresh --clone-login", "startTimeout": 240000, "tab": "shigomori-dev://" }
```

`attach` drives the window over Chromium's debugging port. `address`
and `start` are what make weblab launch it: nothing answers at the
port yet, so it runs `pnpm device` with the port in `PORT`, waits for
the port, attaches, and stops the window when the session ends.

`pnpm device <profile> [--fresh] [--clone-login]`
(`scripts/dev-device.mts`) runs a dev window as a dev profile (below)
with its debugging port on `PORT` (or `SHIGOMORI_DEBUG_PORT`). The
first window of a worktree is the primary, a full `pnpm dev`: the
build, the renderer's vite server, deep links. A window started while
that server answers is a peer on the primary's build, so open the
primary first, and end the peers before it, or everything at once.

Each window's Devices page should list the other device as online,
then connected. The device names end in `[<tag>-a]` and `[<tag>-b]`.
Then drive them:

```json
{ "session": "a", "steps": [
  { "expect": { "js": "window.api.account.status().then((s) => s.signedIn)" }, "timeout": 60000 },
  { "js": "window.api.hub.status()" },
  { "js": "window.api.deviceId", "on": "b" },
  { "shot": "b-devices", "on": "b" }
] }
```

Drive a window by calling the bridge and asserting on what it returns,
not on the DOM. The preload exposes the real IPC bridge as
`window.api` in the page, and a `js` step awaits what a call returns.
Use the DOM only where a person would click. A session opened with
`"video": true` records its window, so a real two-device flow can be
filmed, one video per window.

When you are done, revoke both devices before ending the sessions.
Ending a window does not unenroll it. See "Cleaning up".

### Builds and data folders

The app has two builds. Each keeps its own state.

|                       | Packaged app                                    | Dev app (`pnpm dev`)                                  |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Data dir              | `~/.sm`                                         | `~/.smd`                                              |
| Data dir pointer file | `~/.config/shigomori/data-dir`                  | `~/.config/shigomori-dev/data-dir`                    |
| userData (macOS)      | `~/Library/Application Support/Shigoto no Mori` | `~/Library/Application Support/Shigoto no Mori (dev)` |
| CLI                   | `sm` (bundled)                                  | `smd` (`dist-cli/smd`, built by `pnpm dev`)           |
| Renderer scheme       | `shigomori://app`                               | `shigomori-dev://app`                                 |
| Hub and Clerk config  | Baked in at build time                          | `.env.local` (`hub-dev.shigomori.com`)                |

A device is made of two folders:

- **Data dir.** Projects and worktrees: `registry.json` (projects
  and the device id), `state.json`, `config.json`, `projects/`,
  `worktrees/`, and while the app runs `control.json` (how the CLI's
  cross-device verbs find it). The device id is created per data dir,
  so one data dir is one device. A pre-2.0 `~/shigomori` (`~/shigomori-dev`) that still
  holds state is adopted in place until `~/.sm` (`~/.smd`) holds state;
  Settings > Data location offers to rename it, and `sm doctor` warns.
- **userData.** The app instance: `account.json` (hub credential and
  the accept-commands switch), `clientConfig.json` (theme,
  keep reachable), `clerk-tokens.json` (Clerk session),
  `cloudflared.pid`. Sign-in state lives here, not in the data dir. It
  also holds the single-instance lock, so only one app can run per
  userData.

### Changing where the data lives

- `SHIGOMORI_DATA_DIR=<dir> pnpm dev` uses `<dir>` as the data dir for
  that session only. The app and every CLI child it spawns use it.
  Moving the data dir from Settings is disabled in such a session.
- The **data dir pointer file** holds one absolute path and relocates
  the build's data dir permanently. The app writes it when the data folder is
  moved from Settings. It can also be edited by hand. The target must
  be missing, empty, or already contain shigomori state, or it is
  ignored.
- Neither option changes userData. Two devices on one machine need
  different data dirs _and_ different userData. Dev profiles (below)
  provide both.


### Filling a data dir with test repos

There is no shared fixture. Create the repos a test needs with
`git init` and `git commit`, then register every repo under a
directory in one call:

```sh
smd projects add <dir> --all --yes     # set SHIGOMORI_DATA_DIR if the data dir is sandboxed
```

- Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` so commits do not depend on
  the machine's git config.
- A worktree can only be pulled between devices that hold the same
  repo, matched by root commit. Clone one repo into both profiles
  instead of creating it twice. `seedFixture` in
  `remote-smoke/fixture.mts` shows the pattern.


### Running the dev app

`pnpm dev` (and the primary `pnpm device`) does the following:

1. Builds the dev CLI (`dist-cli/smd`).
2. Fetches the pinned `cloudflared` binary.
3. Allocates this worktree's dev server ports with port-pool (into
   `.env.ports`): the renderer's `PORT`, plus `WEB_PORT`,
   `FAKE_HOST_PORT` and `FAKE_HOST_WEB_PORT` for `pnpm web:dev`,
   `pnpm fake-host` and `pnpm fake-host:web`, which run the same step. A
   checkout allocated before the pool gained or renamed a port is
   released and allocated afresh, which can move its ports. A line the
   pool no longer writes stays in `.env.ports`, unread.
4. On macOS, clones Electron into a per-worktree bundle under
   `.electron-dev/` and launches from it, so GitHub sign-in can
   deep-link back. The most recently launched worktree owns the
   `shigomori-dev://` scheme.

### Environment variables

| Variable                           | Effect                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `SHIGOMORI_DATA_DIR`               | Data dir for this session. See above.                                         |
| `SHIGOMORI_PROFILE`                | Dev profile name. The launchers set it, and it requires `SHIGOMORI_DATA_DIR`. |
| `SHIGOMORI_DEBUG_PORT`             | Opens Chromium's remote-debugging port on that window. Dev builds only.       |
| `SHIGOMORI_DIAL_KINDS`             | Candidate kinds this device dials, e.g. `tunnel`. Dev builds only. See Rules. |
| `PORT`                             | Renderer port, from `.env.ports`. A real env var overrides it. To `pnpm device`, the debugging port instead (what weblab's `start` passes); it never reaches the app. |
| `WEB_PORT`                         | Web client port (`pnpm web:dev`). Same source and override rule.              |
| `FAKE_HOST_PORT`, `FAKE_HOST_WEB_PORT` | Fake host ports (`pnpm fake-host`, `pnpm fake-host:web`). Same source and override rule. |
| `SM_DEVICE_HUB_URL`                | Device hub URL. Normally from `.env.local`; a real env var overrides it.      |
| `SM_ACCOUNT_CLERK_PUBLISHABLE_KEY` | Clerk key. Same override rule.                                                |
| `SM_ACCOUNT_WEB_ORIGIN`            | Web client origin the desktop admits. Same override rule.                     |
| `SHIGOMORI_UPDATE_FEED_URL`        | App only. Stand-in for the update server, on prerelease builds too.          |
| `SHIGOMORI_UPDATE_RELEASES_URL`    | App only. Stand-in for the GitHub release list (prerelease builds).          |

The app passes the two update stand-ins to its own update check and
removes them from its environment, so scripts it runs don't inherit
them. `sm update` refuses to run with either set. From a terminal,
pass them to the command instead: `sm update --feed-url <url>` or
`--releases-url <url>`.


### Theme hotkeys

In a dev build, `Ctrl+T` toggles light/dark, `Ctrl+D` toggles
doubutsu, `Ctrl+P` cycles the current appearance's doubutsu palette,
and `Ctrl+R` resets to the saved theme. These are previews and are not
saved.


### Dev profiles

Every remote flow needs a second device. A **dev profile** is an extra
dev instance on this machine with its own data dir, userData, device id
and sign-in. Two profiles are two devices on the hub. They connect to
each other over the LAN.

```
~/.smd-profiles/<name>/data    data dir
~/.smd-profiles/<name>/repos   test repos for the profile
<dev userData>/profiles/<name>          userData
```

Profiles made before 2.0 lived under `~/shigomori-dev-profiles/<name>/`
and are not migrated: revoke their devices, delete that folder, and
start them again with `--fresh`.

Profile names are lowercase letters, digits and dashes, up to 32
characters. `scripts/lib/devProfile.mts` owns the layout.


`pnpm device <name>` runs one (`pnpm dev --profile <name>` too, for a
primary in a terminal).

| Flag            | Effect                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--fresh`       | Wipe the profile's folder and userData before launch.                                                                                 |
| `--clone-login` | Copy the plain dev app's Clerk sign-in into the profile. The profile boots signed in and enrolls as a new device on the same account. |

### Signing a profile in

The plain dev app (`pnpm dev` without a profile) must be signed in
once before `--clone-login` works, and stay signed in: its Clerk
session can lapse while its device credential lives on, and then it
still reads signed in while every clone boots signed out (see
Troubleshooting). Cloning only works on macOS. Linux and Windows key
the dev token store per app name, so the copied file decrypts to
nothing and the profile boots signed out.

Without `--clone-login`, sign in from the profile's own window using a
method that stays in the window. GitHub sign-in uses a deep link, and
with two windows from the same bundle the OS picks which one receives
it. The Clerk dev instance currently offers GitHub only, which is why
cloning exists.

### Rules

- **The peer needs the primary running.** It has no build of its own.
- **A data folder move restarts the app through the launcher.** The
  app touches a marker and quits, and `pnpm dev` starts forge again
  (vite included) instead of leaving a detached Electron on a dead
  renderer. The peer relaunches itself, and its wrapper exits.
- **A main-process change restarts nothing by itself.** Forge rebuilds
  the main bundle (it prints `target built`) but leaves the primary
  running on the old code: type `rs` in the `pnpm start` terminal to
  restart it. The peer keeps the code it booted with until it is
  relaunched.
- **Never press Sign out in a cloned window.** A cloned sign-in shares
  one Clerk client with the plain dev app, so signing out ends the
  session for both. End a cloned profile by revoking its device
  instead: run `window.api.account.signOut()` in a `js` step, or use the
  Devices page of another device. Then run with `--fresh` or delete
  the folders.
- **`--fresh` is local only.** A device the profile enrolled stays on
  the hub, with its tunnel, until revoked. Leftovers show on the
  Devices page of any device on the account and can be revoked there.
  See "Cleaning up after a session". A sign-out that could not reach
  the hub (offline, hub down) parks its revoke in the signed-out
  envelope and delivers it on the next launch or the next sign-in, so
  a leftover from an offline sign-out clears itself once the profile
  runs online again.
- **A device revoked while it was off** learns it on its next launch:
  the hub answers its dead credential with a typed "device revoked"
  (a tombstone, `hub/migrations/0002_revoked_credentials.sql`), and
  the app signs out exactly as if it had been online for the revoke.
  Apply the migration before deploying the Worker. Against a hub
  without it a revoke still lands (without its tombstone), and the
  offline device instead sits "blocked: refused" with the raw
  credential error, signed in, until signed out by hand.
- **Both profiles use the owner's real dev account.** Each enrolls on
  the dev hub and provisions a tunnel. This is intended: the hub,
  Clerk and tunnel provisioning are exercised for real.
- **The tunnel data path needs asking for on one machine.** The LAN
  candidate always wins locally. Launch one profile with
  `SHIGOMORI_DIAL_KINDS=tunnel` and its session to the other rides that
  device's tunnel, the way a web client's does (the other profile's log
  says `deflating large frames for <device> (tunnel-borne)` when it
  lands). The dev hub needs the tunnel secrets configured. The web
  client (below) is the other way.


### Useful bridge calls

| Call                                                                | Returns                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window.api.deviceId`                                               | This window's device id.                                                                                                                                                                                                                                                                             |
| `window.api.account.status()`                                       | `signedIn`, `accountId`, `deviceName`, `configured`.                                                                                                                                                                                                                                                 |
| `window.api.account.listDevices()`                                  | The account's device registry from the hub, with `online`.                                                                                                                                                                                                                                           |
| `window.api.account.setAcceptsCommands(bool)`                       | Flips this device's command-access switch.                                                                                                                                                                                                                                                           |
| `window.api.account.signOut()`                                      | Revokes this device and clears the credential. Clerk is untouched.                                                                                                                                                                                                                                   |
| `window.api.hub.status()`                                           | Socket phase, `onlineDeviceIds`, `peerAppVersions` (one key per direct session), `peerAcceptsCommands` (whether each runs this device's commands), `tunnel`.                                                                                                                                         |
| `window.api.hub.invokePeer({deviceId, channel, input})`             | Any host call on a peer, e.g. `projects:list`, `worktrees:list`, `worktrees:create`.                                                                                                                                                                                                                 |
| `window.api.sync.pullWorktree({...})`                               | Brings a peer's worktree here. See the smoke for the payload. With `ignoreMode` and `ignores` (the mirror's leave-out rule) it also brings the ignored files the rule admits, through the mirror engine run once and one way, source to here (the `files` step, reported as `files` on the result). `gitignored` has nothing to bring and skips it. |
| `window.api.sync.sendWorktree({targetDeviceId, projectId, worktreeId, ...})` | The pull turned around: sends one of this device's worktrees to a peer (the local page's "Transplant to"). The peer runs the pull's own landing, asking back over a link this device opens, and its progress (the create's phases included) comes back here. Takes the pull's `runSetup`, `ignoreMode`, `ignores` and `cloneInto`, and returns the pull's result, with `worktree` the copy on the peer. Only the peer has to accept commands. |
| `window.api.sync.cancelMove({sourceWorktreeId})`                    | Cancels a move in flight, by the source worktree its progress is keyed under: a `pullWorktree` or `sendWorktree` this device runs, or a `mirror.startTo` (asked of the device running it, the peer for "Mirror here"). The move fails with `The move was cancelled`, whatever it was waiting on: the create's CLI child (and the setup script it runs) is killed, the worktree it made is removed with `sm rm --force` (its cleanup on a one-minute clock), a link is reset, a files-step session ended, and a mirror's session terminated if the open outran the cancel. A repo the move cloned first stays as a project. Nothing on the source changes, and no receipt is kept, so no teardown follows. `cancelled: false` means nothing by that key was in flight (the move is over). A caller that goes away (the window reloads, a peer's or the CLI's socket dies) cancels the same way. The dialogs' running step has the Cancel button. Escape and the backdrop still don't close it. |
| `window.api.sync.teardownSource({direction, deviceId, projectId, worktreeId})` | Second half of a transplant, either way: removes the source while it is still what moved. `deviceId` is the peer the move came from (`pull`) or went to (`send`), and `projectId`/`worktreeId` name the source worktree (the peer's after a pull, this device's after a send). |
| `window.api.sync.ignoredPaths({projectId, worktreeId})`             | The ignored files on a worktree (`paths`, full `total`) and the gitignore rules behind them (`patterns`). Grant-gated. The transplant dialog lists them, the mirror dialog chooses from them.                                                                                                        |
| `window.api.sync.worktreeFolder({projectId, worktreeId, relative})` | One folder of a worktree with git's ignore verdict per entry. Grant-gated. The mirror dialog's picker browses it.                                                                                                                                                                                    |
| `window.api.worktrees.readFile({projectId, worktreeId, path})` | One file of a worktree for the files page: `{kind: "text", contents, size}`, or `binary` / `tooLarge` (over 1 MiB) with the size, or `missing`. Grant-gated like `worktreeFolder`, which the page browses with. |
| `window.api.projects.carryOverListing({...})` | One folder of a project (`projectId`, `relative`), unioned across its checkouts on that device. Not grant-gated. The carry-over picker browses it, and with `ruleIgnored: true` the Configure page's leave-out picker does, on every device holding the repo. |
| `window.api.portForward.start({deviceId, remotePort})`              | Forwards a peer's loopback port. Returns `localPort`.                                                                                                                                                                                                                                                |
| `window.api.mirror.startTo({targetDeviceId, projectId, worktreeId, ...})` | Copies one of this device's worktrees to a peer and keeps the two mirrored (files both ways, git state followed). The `sync.sendWorktree` payload plus `ignoreMode` (`everything`, `gitignored`, `custom`, `bring`) and `ignores` (engine patterns, `/path` anchors to the root). `bring` is gitignored with exceptions: the gitignore rules, a marker pattern, then a `!/path`, `!/path/**` pair per ignored path that crosses anyway, its glob syntax escaped (`bringIgnores` in `shared/mirrorIgnores.ts`). `runSetup: false` skips the setup script at the copy's create (the dialogs default it off when nothing is left out, and on once the rule leaves something behind). A mirror always runs on the device holding the original, labelled `copySide: "remote"`, so `mirror.stop` removes the peer's copy and keeps the original. The local page's "Mirror to" calls it here. A peer's page ("Mirror here") runs `window.api.mirror.startFrom({sourceDeviceId, sourceProjectId, sourceWorktreeId, sourceIdentity, runSetup?, ignoreMode, ignores, cloneInto?})` here instead (what the peer's `startTo` takes, in the pull's terms, plus the rule and the identity the landing is held to): it invites the mirror (`host/mirror/invites.ts`), asks the peer's `mirror:startTo` with this device as `targetDeviceId`, and relays the peer's progress. The peer must accept commands (it is asked). This device need not, since it asked: the invitation admits exactly the calls the contracts tag `invitable` (the peer's landing of that original into that repo and clone place, then the copy's stream, git state, commit fetch and push, and delete), and goes with the copy. Landed invitations persist in `file-sync/mirror-invites.json`, checked against the listed worktrees at boot. Returns the copy and the `session`. A session an older build started from the copy's device (no `copySide` label) is ended on the first launch, its worktree kept and its thread saying to start it again from the original's page. |
| A device with no checkout of the repo                               | Every move takes `cloneInto: {parentDir, name}`, a place on the landing device: `sync.pullWorktree` for this device, `sync.sendWorktree` and `mirror.startTo` for the peer (this device, when a peer runs `mirror.startTo` towards it). With no project of the source's identity there, the source's default branch crosses as a bundle on the move's own link (no remote needed, the grant that gates the move is the gate), is checked out at `parentDir/name` (the parent is made when missing), given the source's remote as `origin` when it has one, registered the way `projects.clone` registers (`sm projects add`, config seed included), and the copy lands in it as usual. A copy that would land on the clone's own default branch is refused before anything is made. Reported as the `clone` step (with bytes) and as `cloned` (the new project) on the result. A project that matches wins over `cloneInto`: nothing is cloned. Without `cloneInto` the move refuses as before. The dialogs offer it ("Mirror here", "Transplant here" on a peer's worktree when this device holds no checkout, "Mirror to…", "Transplant to…" onto a peer that holds none), defaulting the folder to the source's own layout with its home swapped for the destination's. The CLI's `send` and `mirror --to` take such a device too, cloning into the same default (or `--clone-into <dir>`, a folder on it). `bring` and `mirror --from` still need a device that holds the repo. |
| Mirroring a primary checkout                                        | The start takes a primary, from either page. Its copy is an ordinary worktree on `mirror/<branch>` in a `mirror-<name>` folder (the landing device's own primary holds `<branch>` and is usually called `<name>`), and the git follower reads the pair as one branch: a commit on the source's `main` lands on the copy's `mirror/main` and back. The session carries a `mirrorBranch: "1"` label, which is all the follower needs: the rule holds for every branch the primary moves to. Both primaries stay untouched, and stop removes the copy as usual. The CLI's `mirror --from` and `mirror --to` take a primary the same way. `bring` and `send` refuse one. |
| `window.api.mirror.list()`                                          | This device's mirror sessions (`status`, `git.status`, conflicts, `ignoreMode`, `ignores`, `createdAt`) and the streams it serves for peers (`peerWorktreeId` names the peer's copy).                                                                                                                |
| `window.api.mirror.stop(session)` / `pause` / `resume`              | Controls a session this device runs. Stop also removes the copy, on the peer (a forced delete, and the original keeps its own), so the copy's page moves on. A copy the peer no longer lists (deleted from a terminal, or while this device was away) ends the session without the synced check, and with nothing to remove. A copy deleted in the app ends its session here on its own, through the peer's `worktrees:removal` announcement. Served to peers on this device's command grant: the far end's page drives the session through the device running it (`hub.invokePeer` to it, in the console), so either side controls the mirror.                              |
| `window.api.mirror.setIgnores({session, ignoreMode, ignores})`      | Changes what a running mirror leaves out. Re-opens the session and returns the new id. Served to peers like the controls above.                                                                                                                                                                         |
| `window.api.mirror.history({localWorktreeId})`                      | The mirror's thread of events, kept by the device that runs it and keyed by its local worktree, the original.                                                                                                                                                                                                      |


### Two argument conventions

- `window.api.<module>.<call>` uses the renderer's signature, defined
  per call in `shared/ipc/client.ts`. Some calls take positional
  arguments, e.g. `portForward.stop(forwardId)` and
  `ports.list(projectId, worktreeId)`.
- `hub.invokePeer` and the check scripts use the raw contract payload
  from `shared/ipc/modules/<module>.ts`.

A rejection with a zod issue list means the payload shape matches the
wrong convention.


### From a terminal

The same verbs are on the CLI, which asks the running app for them
(`main/core/control/server.ts`). Point `smd` at the profile whose app
should act, from a checkout of the repo:

```sh
export SHIGOMORI_DATA_DIR=~/.smd-profiles/<tag>-a/data
smd devices
smd worktrees send [<name>] [--to <device>] [--clone-into <dir>]  # sync.sendWorktree
smd worktrees list --remote [--from <device>]
smd worktrees bring <worktree> [--from <device>]   # sync.pullWorktree
smd worktrees mirror [<name>] [--to <device>]      # mirror.startTo
smd worktrees mirror <worktree> --from <device>    # mirror.startTo, run on that device
smd worktrees mirrors                              # the mirrors this device is part of, either side
smd worktrees unmirror [<name>] [-f]               # mirror.stop, through the peer for a mirror it runs
```

With the app not running (or another profile's data dir) every verb
fails with `app-not-running`. `pnpm test control` covers the verbs
without an app, and the smoke's `cli:` scenario covers them with two.


### DOM hooks

Use the DOM only where a person would click. The sidebar's Devices
button has `aria-label="Devices"`. Clerk's modal is plain DOM in the
page, with `.cl-*` classes.


### Cleaning up

Every profile enrolls a device on the dev hub. Ending a window,
`--fresh` and deleting folders are local: the device and its tunnel
stay on the account until revoked. So revoke first, then end.

A window launched with `--fresh --clone-login` in this run can revoke
the others and then itself. Not one that booted with its credential
on disk (a relaunch): it holds a live Clerk session and no enrollment
attempt armed, so ClerkAccountSync re-enrolls it the moment the
credential clears. Revoke such a window from another device, and
never with its **Sign out** button in a cloned window (see Rules).

```json
{ "session": "a", "steps": [
  { "js": "window.api.account.listDevices().then((ds) => Promise.all(ds.filter((d) => / \\[<tag>-[a-z0-9-]+\\]$/.test(d.name) && d.deviceId !== window.api.deviceId).map((d) => window.api.account.revokeDevice(d.deviceId).then(() => d.name))))" },
  { "js": "window.api.account.signOut()" }
] }
```

Match your own tag, not every `[...]`: those may be another session's
live devices. Then `end`, and delete the local halves, or launch with
`--fresh` next time:

```sh
for p in <tag>-a <tag>-b; do rm -rf ~/.smd-profiles/$p "$HOME/Library/Application Support/Shigoto no Mori (dev)/profiles/$p"; done
```

A device removed from the account while it runs signs itself out: a
packaged or plain dev app ends its Clerk session too and lands on the
signed-out Devices page, while a profile that holds a cloned sign-in
(`--clone-login` leaves a marker beside the token store) only drops
the account layer, since its Clerk session is the plain dev app's and
ending it would sign every window out. Such a profile re-enrolls if
relaunched. Either way the sign-out tears the remote setup down with
it: the hub socket and the tunnel stop, every direct session closes,
port forwards end, every mirror ends (its copy stays as an ordinary
worktree, and the thread says why), the shared settings copy is
dropped (the peers hand it back on the next sign-in), the login item
is cleared (packaged builds only: a dev run never installs one), and
the window shows no peers (no device tabs, no device filter) until
the next sign-in. The devices that stay end their
mirrors with the removed one the next time they read the registry. A
relaunch after `--fresh` is a new device. The remote smoke cleans up
its own `e2e-*` profiles unless run with `keep`.

## The remote smoke

`remote-smoke/` runs the full remote loop with no interaction, as a
weblab code file on two device windows. Start device a, which seeds
the fixture first, then run the scenarios on it. They start device b
themselves:

```json
{ "name": "a", "attach": "127.0.0.1:9241", "address": "127.0.0.1:9241", "start": "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON app/test/remote-smoke/boot.mts a", "startTimeout": 300000, "tab": "shigomori-dev://" }
```

```json
{ "session": "a", "file": "app/test/remote-smoke/smoke.mts", "params": { "only": "presence,pull" } }
```

Then `end`, which stops both windows and clears what the run left on
this machine. The paths above are from the checkout's root, weblab's
usual `dir`.

- `params.only` runs the scenarios whose label contains one of the
  comma-separated parts, for a quick pass over one area. The boot and
  the teardown always run. A scenario that builds on an earlier one's
  result fails when that one was filtered out, so name both. Without
  it, every scenario runs, which takes a minute or two: `run` replies
  with what it has after `wait` (45 seconds unless given), and `run`
  on `a` with no steps collects the rest.
- `params.keep` (`true`) skips the teardown, leaving both devices
  enrolled and both windows up for a look.
- The reply holds the code's return value (the scenarios that passed)
  or, when any failed, each failure on one line, with a screenshot of
  both windows per failure. `remote-smoke.log` in weblab's files
  directory has each scenario's outcome as the run goes.

What a run does:

1. `boot.mts a` builds the dev CLI and the file-sync engine, creates
   one repo and clones it into two fresh profiles, `e2e-a` and `e2e-b`
   (both sides need the same clone because the pull matches projects
   by repo identity), clones the dev sign-in into both, and starts a
   as the primary.
2. The scenarios start b as the peer (`boot.mts b`, on a free port),
   wait until each holds a direct session to the other, revoke any
   other `[e2e-a]` or `[e2e-b]` device an earlier run left on the
   account (the CLI scenario names devices by name), then turn both
   command-access switches on: a mirror runs on the device holding the
   original, so one of b's worktrees mirrored onto a is b's session,
   asked for over b's switch and landing the copy over a's. The
   scenarios about a refusal turn one off and back on.
3. They run the scenarios below.
4. They revoke what is still enrolled and end b, which clears b's
   profile. Ending a clears the rest: its profile, the shared origin
   and the run's scratch directory.

| Scenario     | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| presence     | Each roster holds the other. a's registry shows b online.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| remote read  | a lists b's projects and the main worktree of `shared`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| shared settings | With b's switch off, a value written on a lands in b's own copy by b's pull alone. With it on, one written on b lands in a's, and the two copies read identical. |
| grant gate   | With b's switch off, a's `worktrees:create` on b is refused with the typed message. With it on, `feat/e2e` is created and the path exists on disk.                                                                                                                                                                                                                                                                                                                          |
| pull         | a pulls `feat/e2e` (the transplant's first half). The worktree lands under a's data dir on that branch. a's project carries a setup script that logs each run, and the pull runs it once.                                                                                                                                                                                                                                                                                                                                                                     |
| mirror: onto a device with no checkout | b holds a repo with no remote that a has no checkout of. a asks b to mirror it onto a, and b's start refuses until told where to clone (in a's terms), then clones the repo over the device link into a's repos folder, registers it there with the same identity, lands the primary's copy on `mirror/main` beside it, and runs the session. A commit on b reaches the copy. b's stop removes the copy and leaves the clone as an ordinary project. |
| transplant: onto a device with no checkout | With a's clone of that repo removed again, a dirty worktree of b's comes to a through the same clone-first pull: the repo is cloned, the branch lands in it with the edits applied, and the source is torn down on b. |
| mirror: primary checkout | b's primary checkout is mirrored onto a, b running the session. The copy is a worktree on `mirror/main` in a `mirror-` folder, a commit on b's primary lands there and one made there lands on b's primary, both primaries stay on their own branches, the copy follows b's primary onto a new branch and back, and an unforced stop on b removes the copy alone. |
| transplant   | a tears the source down. It is gone from b's disk and still present on a.                                                                                                                                                                                                                                                                                                                                                                                                   |
| mirror       | a asks b to mirror a fresh worktree of b's onto a (a's `mirror:startFrom`, which runs `mirror:startTo` on b with a as the target) with `runSetup: false` and a's command access OFF, and the setup script does not run: the ask's invitation is what b's send, stream and git half land through. The session is b's, which holds the original: b lists it (its local side the original, labelled `copySide: "remote"`) with its ignore rule and start time, a runs none, a's served stream names b's original, and b's history opens with `started`. Files written on either side land on the other, a gitignored file included. A commit on b lands on a with the same tip and a clean status. Changing the ignores on b re-opens the session, and a path under the new rule stays on a while its sibling crosses. Stopping on b clears b's session and a's served stream, and removes a's copy from disk. |
| transplant: setup off, nothing left out | The dialogs' default pairing. Setup does not run, the uncommitted work is re-applied, and every ignored file lands with the source's content, its build output included. The transfer is one way and leaves no session on either device. The finish step removes the source. |
| transplant: setup on meets the source's build | Setup on with nothing left out. The copy keeps the build output its own setup made, the clash is counted in the result, the other ignored files cross, and the source is not written to. |
| transplant: custom rule | The picked path stays on b while its ignored siblings cross. |
| transplant: gitignored rule | The review's ignored list names the right paths. No files step runs, no ignored file crosses, and an absent `runSetup` runs setup. A clean source is removed without force. |
| transplant: bring rule | Gitignored with an exception. The picked ignored path crosses, and its ignored siblings stay on b. |
| transplant: failing setup script | A setup script that exits non-zero leaves a real worktree with the uncommitted work applied. |
| pull refusals | A second transplant and a mirror of a branch a already holds, a taken folder name, and a branch gone from the source are all refused, leaving no worktree, no session on b and no incoming ref. A source edited after its transplant is kept by the finish step, with the reason. |
| transplant to a peer | a sends one of its own worktrees to b with a's own switch off: only b has to accept commands. The branch, the uncommitted work and the ignored files land on b with no incoming ref left there. A second send is refused by b, and the finish step removes a's source only once it again matches what was sent. |
| cli: send, bring and mirror | The same verbs from the real `smd`, pointed at a's data dir. `send --source teardown` moves a's worktree to b, `list --remote` shows it there and `bring` brings it back. `mirror` copies it to b under a session a runs, answers a second ask with the running mirror, and carries a file and a commit across. Pointed at b's data dir, `mirrors` lists that mirror from b's side (copy local, a the other device) and `unmirror` is refused while a accepts no commands, then removes b's copy only and ends a's session. `mirror --from` runs with a accepting no commands: b runs it, its send and session landing on a through the ask's invitation, b's session has b's original as its local side, commits made on either side reach the other while a's switch stays off, and a's `unmirror` stops it through b, removes a's copy and keeps b's original. |
| mirror to a peer | a copies one of its own worktrees to b and runs the mirror itself, as the holder of the original. Files and a commit made on b's copy come back to a, and the stop removes b's copy while a's original stays. |
| mirror: gitignored rule, setup on, pause | One of b's worktrees mirrored onto a, b running it. Setup runs on a's copy, each side keeps its own ignored files, and tracked work crosses. A mirror paused on b carries nothing, and resuming carries what was held. |
| mirror: controlled from the other device | a holds the copy of a mirror b runs, sees b's session against its copy, and is refused while b accepts no commands. With b's switch back on, a pauses it (a file written meanwhile stays put), resumes it (the file crosses), and stops it unforced: a's copy goes, b's original stays, and a's served stream ends. |
| mirror: diverged stop is refused | Both sides commit while paused. The pair reads diverged with both tips untouched, and Stop is refused and changes nothing, asked on b or from a through b. The forced stop on b ends the session and removes a's copy with its commit, and b's original keeps its own. |
| dialog: mirror with the default switch | Drives the real dialog from the sidebar. The switch is off under Nothing, follows Gitignored to on and back, the running view lists the setup step as skipped, and the mirror it starts (on b, which holds the original) runs no setup on a's copy. |
| dialog: transplant with the switch pinned off | The switch turned off under Gitignored stays off through rule changes, the running view lists setup as skipped, and the transplant runs no setup and brings no ignored file. |
| dialog: transplant with the switch pinned on | The switch turned on under Nothing runs setup, the running view names the setup command, and the copy keeps its own build output. |
| dialog: transplant to a peer | The local page's "Transplant to…" opens on b, its one ready device. The copy lands there with a's edit, and "Tear it down" removes a's source and leaves for the copy's page on b. |
| dialog: transplant cancelled mid-setup | With a's setup script hung on a sleep, the running view's Cancel reads "Cancelling…" and then "Transplant cancelled" within moments. The sleep is dead, the copy is gone from a's disk, list and incoming refs, b's source keeps its uncommitted edit, and a second cancel finds nothing. |
| dialog: mirror cancelled mid-setup | The same through "Mirror here": b runs the start, the cancel goes to b, and b's torn-down link cancels a's landing. "Mirror cancelled", no session on b, no copy on a. |
| port forward | a forwards a loopback echo server on b. Bytes round-trip.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| clone onto a peer | a asks b to clone a loopback `git://` remote into b's repos folder and register it. Refused with commands off (the folder listing too), and for an option-shaped string or a path as the URL. The checkout lands, lists with an identity, and its `cloneUrl` reads back, where the path-origin shared repo answers null. A second clone onto the folder is refused.                                                                                                     |
| liveness     | b is killed with SIGKILL. a drops it from the roster. b relaunches and both reconnect.                                                                                                                                                                                                                                                                                                                                                                                      |
| shared settings: offline catch-up | b is killed, a writes a value, b relaunches. b's copy takes the value once its session lands, with no server having held it. |
| revoke       | a removes b from the account after starting a mirror each way, each run by the device holding the original. a's roster and registry drop b, and b signs itself out of the account: its hub socket stops, its direct sessions close, the port forward it ran is gone, its mirror onto a ends (the copy on a kept), its shared settings are dropped, and no device tabs remain. a ends its mirror onto b too, once its registry read no longer lists b, the copy on b kept. |

Two mirror checks are still by hand. With a mirror running, relocate
its original on the device running it: that device's session is gone
from `window.api.mirror.list()`, and the other device's page for the
copy no longer says it is mirrored. And a delete the
CLI refuses (dirty tree, no force) leaves the mirror running. The
forced stop is the "diverged stop" scenario above.

Prerequisites:

- The plain dev app signed in, with a live Clerk session (see
  "Signing a profile in").
- The Go toolchain (for the dev CLI and file-sync engine builds).
- No other `pnpm dev` running from the same worktree. The primary
  needs the renderer port.

To add a scenario, add a `scenario("name", async () => { ... })` block
to `remote-smoke/smoke.mts` and assert through the bridge and the
disk. The file runs in weblab's runtime, not node: it can import the
app's modules and npm packages, but not a native addon (`node-pty`,
so not `host/lib/scripts/process.ts`). What it prints with
`console.log` goes to weblab's stderr, so it writes its progress to
the log above.

## Other tools

- **Web client** (`pnpm web:dev`, port `WEB_PORT`). A third device that
  connects through the tunnel only, so it is the way to test the
  tunnel data path on one machine. Launch the desktop with
  `SM_ACCOUNT_WEB_ORIGIN` set to the web client's origin so it admits
  it:
  `SM_ACCOUNT_WEB_ORIGIN=http://localhost:$(sed -n 's/^WEB_PORT=//p' .env.ports) pnpm dev`. The dev hub needs the tunnel secrets configured. The web
  client is a hostless controller: it is the desktop with no local
  projects, so anything a desktop can do to a peer (browse its
  worktrees, run and watch its scripts, change its settings) works
  from a browser tab the same way, and anything local by nature
  (launch tools, this device's section, port forwarding) is absent.
- **Local hub** (`pnpm -C ../hub dev`). Set `SM_DEVICE_HUB_URL` to
  `http://localhost:8787` to run against a Worker on this machine
  instead of `hub-dev`. Needs `CLERK_SECRET_KEY` in the repo root's
  `hub/.dev.vars`.
- **Packaged build** (`pnpm make`). The only way to test the prod
  scheme registration. Without `APPLE_SIGNING_IDENTITY` in the build
  environment the bundle is unsigned and, like dev, runs on
  Chromium's mock keychain: the real keychain is exercised only by a
  Developer-ID-signed build (the release workflow). Such a local
  build shares the installed app's userData, and tokens it writes are
  under the mock key, so switching between it and the installed app
  signs the other out once.

## Troubleshooting

- **Blank window, `net::ERR_NETWORK_CHANGED` repeating in the log.**
  The renderer proxy lost the vite dev server while the network
  changed. Relaunch.
- **Second `pnpm dev` fails.** From the same worktree it fails on the
  renderer port. From another worktree it exits at the single-instance
  lock unless it runs as a profile.
- **Profile boots signed out after `--clone-login`.** On Linux and
  Windows the copied token store cannot be decrypted. On any platform
  the plain dev app's Clerk session may have expired, even while it
  still reads signed in: its device credential outlives the Clerk
  session, and a clone copies the empty session. Open the plain dev
  app in a weblab session (`"start": "SHIGOMORI_DEBUG_PORT=$PORT PORT= pnpm dev"`,
  `attach` and `address` on a free port), check
  `{ "js": "Boolean(window.Clerk.session)" }`, and if it is false run
  `{ "js": "window.Clerk.openSignIn()" }` and press Continue with
  GitHub in its window. It signs in again without leaving the account.
  Then relaunch the profile. Otherwise sign in from the profile's
  window.
- **A device from an old profile still shows on the Devices page.**
  `--fresh` and ending a window do not revoke, and a self sign-out
  re-enrolls a relaunched window. Revoke it from another device. See
  "Cleaning up".
- **`smd` in a new terminal acts on the plain dev data dir.** To
  target a profile from the shell, set its data dir first:
  `SHIGOMORI_DATA_DIR=~/.smd-profiles/<name>/data smd ...`.
- **Dev tokens on macOS.** They sit under Chromium's mock keychain,
  obfuscated but not protected. This is what makes `--clone-login`
  possible and is fine on the owner's machine.
- **A packaged build asks for the login keychain password.** The
  "Shigoto no Mori Safe Storage" item in the login keychain was
  created by a binary with a different code signature (a dev run
  before the mock keychain, an older ad-hoc package), so macOS gates
  every read behind a dialog. A signed build replaces the item once
  on its first launch (main/core/keychain/reset.ts) and logs
  `[keychain]`. If the dialogs persist, delete the item by hand
  (`security delete-generic-password -s "Shigoto no Mori Safe
  Storage"`), remove `safe-storage.owned` from the app's userData and
  relaunch. Either way the next launch is signed out once.
