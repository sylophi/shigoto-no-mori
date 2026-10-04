# Device windows

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

Two ways in, and most checks use both: as a person (a `look`, then
clicks by role and name, the way the UI reads) and through the bridge
(a `js` step on `window.api`, which awaits what a call returns). Drive
the UI when the UI is what changed. Check outcomes where they land:
the bridge's answers, the other device's window, and the disk.

When you are done, revoke what you enrolled before ending the
sessions. Ending a window does not unenroll it. See "Cleaning up".

## What you can exercise

- **Two devices, or more.** Each `new` with its own profile and port
  is another device on the account: a third window is `<tag>-c`. The
  web client is one more, through the tunnel only (see "Other tools").
- **A repo both hold.** A worktree moves only between devices that
  hold the same repo, matched by root commit, so clone one repo into
  each profile rather than creating it twice (see "Filling a data dir
  with test repos"). With no checkout on the landing device, the moves
  clone it first, which is worth checking too.
- **Moves, mirrors and their dialogs.** Start them from the UI (a
  worktree page's footer: Transplant, Mirror) or through
  `window.api.sync` and `window.api.mirror`, then watch both windows
  and the disk. `remote.md` lists what each should do.
- **Command access.** `window.api.account.setAcceptsCommands(false)`
  on one device, to see the other's asks refused and what the UI says.
- **The CLI between them.** `smd` pointed at a profile's data dir runs
  the cross-device verbs against its running app ("From a terminal").
- **A device going away.** `end` stops a window cleanly. To kill one
  mid-socket, the way a crash would, kill its process tree (match its
  profile's userData path, for example
  `pkill -9 -f "profiles/<tag>-b"`), then `end` its session and open
  it again with the same `new` (without `--fresh`): it boots as the
  same device. Presence, reconnects and offline catch-up show there.
- **The tunnel path.** On one machine the LAN wins; launch a device
  with `SHIGOMORI_DIAL_KINDS=tunnel` in its `start` to take the
  tunnel instead (see Rules).
- **A record of it.** Each window's session can be opened with
  `"video": true`. Open both before the flow starts so the two videos
  line up. `screen` shots also capture native menus, given Screen
  Recording permission for whatever runs weblab.

## Driving through the bridge

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
| `window.api.sync.pullWorktree({...})`                               | Brings a peer's worktree here. The payload is the contract's, in `shared/ipc/modules/sync.ts`. With `ignoreMode` and `ignores` (the mirror's leave-out rule) it also brings the ignored files the rule admits, through the mirror engine run once and one way, source to here (the `files` step, reported as `files` on the result). `gitignored` has nothing to bring and skips it. |
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
without an app, and `remote.md` says what they should do with two.


### DOM hooks

Use the DOM only where a person would click. The sidebar's Devices
button has `aria-label="Devices"`. Clerk's modal is plain DOM in the
page, with `.cl-*` classes.



## Cleaning up

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
relaunch after `--fresh` is a new device.


## Reference

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
  instead of creating it twice. Seed both before their windows start,
  and start them without `--fresh`, which would wipe what you seeded
  (wipe stale profiles by hand first, see "Cleaning up"):

```sh
git init -q -b main /tmp/<tag>-seed && cd /tmp/<tag>-seed
git commit -q --allow-empty -m Initial
git clone -q --bare . /tmp/<tag>-origin.git
for p in <tag>-a <tag>-b; do
  mkdir -p ~/.smd-profiles/$p/repos
  git clone -q /tmp/<tag>-origin.git ~/.smd-profiles/$p/repos/shared
  SHIGOMORI_DATA_DIR=~/.smd-profiles/$p/data smd projects add ~/.smd-profiles/$p/repos --all --yes
done
```

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
