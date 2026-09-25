# Manual testing

How to run the real app, drive it from a script, and test remote
flows on one machine. Written for people and for agents.

The automated checks (`pnpm test <name>` for the proofs in `test/`, and
the hub's own suite, all listed in `lefthook.yml`) are not covered here.

This is a reference, not a checklist. The commands are examples: test
what your change touches, pick your own names, ports and order, and
skip the rest. The one part to keep as written is the next section.

## Sharing the machine

Other sessions (agents in other worktrees, the owner) may be testing
at the same time. Profiles, ports and the account's device list are
shared by the whole machine, not per worktree.

- **Put a session tag in every profile name**: `<tag>-a`, not `a`. The
  worktree folder name works. A device's name ends in `[<profile>]`,
  so this keeps device names apart too. Two sessions on one profile
  name share its folders, and `--fresh` wipes them under the other.
- **Touch only what carries your tag**: profiles, devices, and
  processes (match on your worktree path, never on `Electron`). An
  unknown device on the account may be another session's live test.
- **Debug ports are examples.** Use any free ones.
- **One smoke run at a time.** It uses the fixed profiles `e2e-a` and
  `e2e-b` and wipes them when it starts.

## Quick start: two devices on one machine

```sh
# 0. Once per machine: sign the plain dev app in (Continue with
#    GitHub), then quit it. Skip it unless step 2 boots signed out.
pnpm dev

# 1. In each terminal: your session tag and two free ports.
TAG=$(basename "$(git rev-parse --show-toplevel)")
PORT_A=9222 PORT_B=9223

# 2. Start the primary dev app as profile "$TAG-a", with a debug port.
SHIGOMORI_DEBUG_PORT=$PORT_A pnpm dev --profile $TAG-a --fresh --clone-login

# 3. In another terminal, start a second window as profile "$TAG-b".
SHIGOMORI_DEBUG_PORT=$PORT_B pnpm dev:peer $TAG-b --fresh --clone-login

# 4. Drive either window from the shell.
node test/e2e/drive.mts $PORT_A eval 'window.api.hub.status()'
node test/e2e/drive.mts $PORT_B shot /tmp/$TAG-b.png
```

Each window's Devices page should list the other device as online,
then connected. The device names end in `[<tag>-a]` and `[<tag>-b]`.

When you are done, revoke both devices before quitting. Closing the
windows does not unenroll them. See "Cleaning up after a session".

To run every remote flow unattended instead:

```sh
pnpm test e2e/remote-smoke
```

The sections below explain each piece.

## Builds and data folders

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
- **userData.** The app instance: `account.json` (hub credential),
  `grants.json` (accept-commands switch), `clientConfig.json` (theme,
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
  instead of creating it twice. `prepareFixture` in
  `test/e2e/remote-smoke.mts` shows the pattern.

## Running the dev app

`pnpm dev` does the following:

1. Builds the dev CLI (`dist-cli/smd`).
2. Fetches the pinned `cloudflared` binary.
3. Allocates the renderer port (`PORT` in `.env.ports`, one per worktree).
   An older `PORT` line in `.env.local` is no longer read and can be
   deleted.
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
| `PORT`                             | Renderer port, from `.env.ports`. A real env var overrides it.                |
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
doubutsu, and `Ctrl+R` resets to the saved theme. These are previews
and are not saved.

## Dev profiles: two devices on one machine

Every remote flow needs a second device. A **dev profile** is an extra
dev instance on this machine with its own data dir, userData, device id
and sign-in. Two profiles are two devices on the hub. They connect to
each other over the LAN.

### Layout

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

### Commands

```sh
# Primary: a full pnpm dev (build, vite server, deep links) running as profile "<tag>-a".
pnpm dev --profile <tag>-a [--fresh] [--clone-login]

# Peer: a second window running as profile "<tag>-b", using the primary's build and vite server.
pnpm dev:peer <tag>-b [--fresh] [--clone-login]
```

| Flag            | Effect                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--fresh`       | Wipe the profile's folder and userData before launch.                                                                                 |
| `--clone-login` | Copy the plain dev app's Clerk sign-in into the profile. The profile boots signed in and enrolls as a new device on the same account. |

### Signing a profile in

The plain dev app (`pnpm dev` without a profile) must be signed in
once before `--clone-login` works. Cloning only works on macOS. Linux
and Windows key the dev token store per app name, so the copied file
decrypts to nothing and the profile boots signed out.

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
  instead: run `window.api.account.signOut()` over CDP, or use the
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

## Driving a window over CDP

Launch any dev window with `SHIGOMORI_DEBUG_PORT=<port>`. Chromium's
remote-debugging endpoint opens on that port. `curl localhost:<port>/json`
lists the targets.

The preload exposes the real IPC bridge as `window.api` in the page.
Drive the window by calling the bridge and assert on the results, not
on the DOM.

### Shell driver

```sh
node test/e2e/drive.mts <port> eval '<expression>'
node test/e2e/drive.mts <port> wait '<expression>' [timeoutMs]
node test/e2e/drive.mts <port> shot <file.png>
```

- `eval` awaits the expression and prints the result as JSON.
- `wait` polls until the expression is truthy.
- `shot` writes a PNG of the window.

Examples:

```sh
node test/e2e/drive.mts 9222 eval 'window.api.hub.status()'
node test/e2e/drive.mts 9222 eval 'window.api.account.status()'
node test/e2e/drive.mts 9222 wait 'window.api.account.status().then(s => s.signedIn)' 60000
node test/e2e/drive.mts 9222 shot /tmp/window.png
```

For scripted use, `test/e2e/cdp.mts` exports `attachWindow`, which
returns a window with `evaluate`, `waitFor`, `screenshot` and `close`.

### Useful bridge calls

| Call                                                                | Returns                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window.api.deviceId`                                               | This window's device id.                                                                                                                                                                                                                                                                             |
| `window.api.account.status()`                                       | `signedIn`, `accountId`, `deviceName`, `configured`.                                                                                                                                                                                                                                                 |
| `window.api.account.listDevices()`                                  | The account's device registry from the hub, with `online`.                                                                                                                                                                                                                                           |
| `window.api.account.setAcceptsCommands(bool)`                       | Flips this device's command grant.                                                                                                                                                                                                                                                                   |
| `window.api.account.signOut()`                                      | Revokes this device and clears the credential. Clerk is untouched.                                                                                                                                                                                                                                   |
| `window.api.hub.status()`                                           | Socket phase, `onlineDeviceIds`, `peerAppVersions` (one key per direct session), `tunnel`.                                                                                                                                                                                                           |
| `window.api.hub.invokePeer({deviceId, channel, input})`             | Any host call on a peer, e.g. `projects:list`, `worktrees:list`, `worktrees:create`.                                                                                                                                                                                                                 |
| `window.api.sync.pullWorktree({...})`                               | Brings a peer's worktree here. See the smoke for the payload. With `ignoreMode` and `ignores` (the mirror's leave-out rule) it also brings the ignored files the rule admits, through the mirror engine run once and one way, source to here (the `files` step, reported as `files` on the result). `gitignored` has nothing to bring and skips it. |
| `window.api.sync.teardownSource({...})`                             | Second half of a transplant.                                                                                                                                                                                                                                                                         |
| `window.api.sync.sendWorktree({targetDeviceId, projectId, worktreeId, ...})` | The pull turned around: sends one of this device's worktrees to a peer holding the same repo (the local page's "Transplant to"). Takes the pull's `runSetup`, `ignoreMode` and `ignores`, and returns the pull's result, with `worktree` the copy on the peer. Only the peer has to accept commands. |
| `window.api.sync.teardownSent({targetDeviceId, projectId, worktreeId})` | Second half of a transplant to a peer: removes the local source while it is still what was sent. |
| `window.api.sync.ignoredPaths({projectId, worktreeId})`             | The ignored files on a worktree (`paths`, full `total`) and the gitignore rules behind them (`patterns`). Grant-gated. The transplant dialog lists them, the mirror dialog chooses from them.                                                                                                        |
| `window.api.sync.worktreeFolder({projectId, worktreeId, relative})` | One folder of a worktree with git's ignore verdict per entry. Grant-gated. The mirror dialog's picker browses it.                                                                                                                                                                                    |
| `window.api.projects.carryOverListing({...})` | One folder of a project (`projectId`, `relative`), unioned across its checkouts on that device. Not grant-gated. The carry-over picker browses it, and with `ruleIgnored: true` the Configure page's leave-out picker does, on every device holding the repo. |
| `window.api.portForward.start({deviceId, remotePort})`              | Forwards a peer's loopback port. Returns `localPort`.                                                                                                                                                                                                                                                |
| `window.api.mirror.start({...})`                                    | Brings a peer's worktree here and keeps the two mirrored (files both ways, git state followed). The `sync.pullWorktree` payload plus `ignoreMode` (`everything`, `gitignored`, `custom`, `bring`) and `ignores` (engine patterns, `/path` anchors to the root). `bring` is gitignored with exceptions: the gitignore rules, a marker pattern, then a `!/path`, `!/path/**` pair per ignored path that crosses anyway, its glob syntax escaped (`bringIgnores` in `shared/mirrorIgnores.ts`). `runSetup: false` on either pull skips the setup script at the create (the dialogs default it off when nothing is left out, and on once the rule leaves something behind). Returns the local worktree and the `session`. |
| `window.api.mirror.startTo({targetDeviceId, projectId, worktreeId, ...})` | The mirror turned around (the local page's "Mirror to"): copies one of this device's worktrees to a peer and keeps the two mirrored. The `sync.sendWorktree` payload plus `ignoreMode` and `ignores`. The session runs here, labelled `copySide: "remote"`, so `mirror.stop` removes the peer's copy and keeps the original. Only the peer has to accept commands. |
| A device with no checkout of the repo                               | Any pull that lands here (`sync.pullWorktree`, `mirror.start`) takes `cloneInto: {parentDir, name}`: with no local project of the source's identity, the peer's default branch is fetched as a bundle (no remote needed, the peer's grant is the gate), checked out at `parentDir/name` (the parent is made when missing), given the peer's remote as `origin` when it has one, registered the way `projects.clone` registers (`sm projects add`, config seed included), and the copy lands in it as usual. A copy that would land on the clone's own default branch is refused before anything is made. Reported as the `clone` step (with bytes) and as `cloned` (the new project) on the result. A local project that matches wins over `cloneInto`: nothing is cloned. Without `cloneInto` the pull refuses as before. The dialogs offer it ("Mirror here", "Transplant here" on a peer's worktree when this device holds no checkout), defaulting the folder to the peer's own layout with its home swapped for this one's. `sendWorktree` and `mirror.startTo` have no such option: the peer must hold the repo, and the CLI's `bring` and `mirror --from` still address a local project. |
| Mirroring a primary checkout                                        | Either start takes a primary. Its copy is an ordinary worktree on `mirror/<branch>` in a `mirror-<name>` folder (the landing device's own primary holds `<branch>` and is usually called `<name>`), and the git follower reads the pair as one branch: a commit on the source's `main` lands on the copy's `mirror/main` and back. The session carries a `mirrorBranch: "1"` label, which is all the follower needs: the rule holds for every branch the primary moves to. Both primaries stay untouched, and stop removes the copy as usual. The CLI's `mirror --from` and `mirror --to` take a primary the same way. `bring` and `send` refuse one. |
| `window.api.mirror.list()`                                          | This device's mirror sessions (`status`, `git.status`, conflicts, `ignoreMode`, `ignores`, `createdAt`) and the streams it serves for peers (`peerWorktreeId` names the peer's copy).                                                                                                                |
| `window.api.mirror.stop(session)` / `pause` / `resume`              | Controls a session this device runs. Stop also removes the copy (here, or on the peer for a `startTo`: a forced delete, and the source keeps its own), so the page moves on. Served to peers on this device's command grant: the far end's page drives the session through the device running it (`hub.invokePeer` to it, in the console), so either side controls the mirror.                              |
| `window.api.mirror.setIgnores({session, ignoreMode, ignores})`      | Changes what a running mirror leaves out. Re-opens the session and returns the new id. Served to peers like the controls above.                                                                                                                                                                         |
| `window.api.mirror.history({localWorktreeId})`                      | The mirror's thread of events, kept by the device that runs it and keyed by its local worktree.                                                                                                                                                                                                      |

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
smd worktrees send [<name>] [--to <device>]        # sync.sendWorktree
smd worktrees list --remote [--from <device>]
smd worktrees bring <worktree> [--from <device>]   # sync.pullWorktree
smd worktrees mirror [<name>] [--to <device>]      # mirror.startTo
smd worktrees mirror <worktree> --from <device>    # mirror.start
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

## Cleaning up after a session

Every profile enrolls a device on the dev hub. Quitting, `--fresh`
and deleting folders are local: the device and its tunnel stay on the
account until revoked. Quit first, then revoke from another device,
then delete.

Do not revoke a window from itself with `window.api.account.signOut()`
unless it was launched with `--fresh --clone-login` in this run. A
window that booted with its credential on disk (a relaunch) has a live
Clerk session and no enrollment attempt armed, so ClerkAccountSync
re-enrolls it the moment the credential clears. The window's **Sign
out** button is not an option either in a cloned window (see Rules).

```sh
# 1. Quit both terminals (Ctrl+C).
# 2. Revoke the profile devices from the plain dev app, which stays a
#    real device. Their names end in "[<profile>]". Either use its
#    Devices page, or open it with a debug port and revoke the ones
#    that carry your tag (not every "[...]": those may be another
#    session's live devices):
SHIGOMORI_DEBUG_PORT=$PORT_A pnpm dev
node test/e2e/drive.mts $PORT_A eval "window.api.account.listDevices().then(ds => Promise.all(ds.filter(d => / \[$TAG-[a-z0-9-]+\]$/.test(d.name) && d.deviceId !== window.api.deviceId).map(d => window.api.account.revokeDevice(d.deviceId).then(() => d.name))))"
# 3. Delete the local halves, or launch with --fresh next time.
for p in $TAG-a $TAG-b; do rm -rf ~/.smd-profiles/$p "$HOME/Library/Application Support/Shigoto no Mori (dev)/profiles/$p"; done
```

The same two calls revoke one device by hand:

```sh
node test/e2e/drive.mts 9222 eval 'window.api.account.listDevices()'
node test/e2e/drive.mts 9222 eval 'window.api.account.revokeDevice("<deviceId>")'
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
mirrors with the removed one the next time they read the registry. A relaunch after `--fresh` is a new device. `pnpm test e2e/remote-smoke` cleans up its own
`e2e-*` profiles unless run with `--keep`.

## Unattended remote smoke

```sh
pnpm test e2e/remote-smoke [--keep] [--only=<label part>,...]
```

`test/e2e/remote-smoke.mts` runs the full remote loop with no
interaction:

1. Builds the dev CLI and the file-sync engine.
2. Creates one repo and clones it into two fresh profiles, `e2e-a`
   and `e2e-b`. Both sides need the same clone because the pull
   matches projects by repo identity.
3. Boots the primary and the peer with cloned sign-ins.
4. Waits until each holds a direct session to the other.
5. Runs the scenarios below.
6. Revokes what is still enrolled, stops both apps and wipes both
   profiles. `--keep` skips this and leaves everything running.

`--only` runs the scenarios whose label contains one of the given
parts, for a quick pass over one area
(`--only="presence,shared settings"`). The boot and the teardown always
run. A scenario that builds on an earlier one's result fails when that
one was filtered out, so name both.

| Scenario     | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| presence     | Each roster holds the other. a's registry shows b online.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| remote read  | a lists b's projects and the main worktree of `shared`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| shared settings | With b's switch off, a value written on a lands in b's own copy by b's pull alone. With it on, one written on b lands in a's, and the two copies read identical. |
| grant gate   | With b's switch off, a's `worktrees:create` on b is refused with the typed message. With it on, `feat/e2e` is created and the path exists on disk.                                                                                                                                                                                                                                                                                                                          |
| pull         | a pulls `feat/e2e` (the transplant's first half). The worktree lands under a's data dir on that branch. a's project carries a setup script that logs each run, and the pull runs it once.                                                                                                                                                                                                                                                                                                                                                                     |
| mirror: onto a device with no checkout | b holds a repo with no remote that a has no checkout of. The start refuses until told where to clone, then clones the repo over the device link into a's repos folder, registers it with the same identity, lands the primary's copy on `mirror/main` beside it, and a commit on b reaches the copy. The stop removes the copy and leaves the clone as an ordinary project. |
| transplant: onto a device with no checkout | With a's clone of that repo removed again, a dirty worktree of b's comes to a through the same clone-first pull: the repo is cloned, the branch lands in it with the edits applied, and the source is torn down on b. |
| mirror: primary checkout | a mirrors b's primary checkout. The copy is a worktree on `mirror/main` in a `mirror-` folder, a commit on b's primary lands there and one made there lands on b's primary, both primaries stay on their own branches, the copy follows b's primary onto a new branch and back, and an unforced stop removes the copy alone. |
| transplant   | a tears the source down. It is gone from b's disk and still present on a.                                                                                                                                                                                                                                                                                                                                                                                                   |
| mirror       | a mirrors a fresh worktree of b's with `runSetup: false`, and the setup script does not run. The session reports its ignore rule and start time, b's served stream names a's copy, and the history opens with `started`. Files written on either side land on the other, a gitignored file included. A commit on b lands on a with the same tip and a clean status. Changing the ignores re-opens the session, and a path under the new rule stays on a while its sibling crosses. Stopping clears a's session and b's served stream, and removes a's copy from disk. |
| transplant: setup off, nothing left out | The dialogs' default pairing. Setup does not run, the uncommitted work is re-applied, and every ignored file lands with the source's content, its build output included. The transfer is one way and leaves no session on either device. The finish step removes the source. |
| transplant: setup on meets the source's build | Setup on with nothing left out. The copy keeps the build output its own setup made, the clash is counted in the result, the other ignored files cross, and the source is not written to. |
| transplant: custom rule | The picked path stays on b while its ignored siblings cross. |
| transplant: gitignored rule | The review's ignored list names the right paths. No files step runs, no ignored file crosses, and an absent `runSetup` runs setup. A clean source is removed without force. |
| transplant: bring rule | Gitignored with an exception. The picked ignored path crosses, and its ignored siblings stay on b. |
| transplant: failing setup script | A setup script that exits non-zero leaves a real worktree with the uncommitted work applied. |
| pull refusals | A second transplant and a mirror of a branch a already holds, a taken folder name, and a branch gone from the source are all refused, leaving no worktree, session or incoming ref. A source edited after its transplant is kept by the finish step, with the reason. |
| transplant to a peer | a sends one of its own worktrees to b, which alone accepts commands. The branch, the uncommitted work and the ignored files land on b with no incoming ref left there. A second send is refused by b, and the finish step removes a's source only once it again matches what was sent. |
| cli: send, bring and mirror | The same verbs from the real `smd`, pointed at a's data dir. `send --source teardown` moves a's worktree to b, `list --remote` shows it there and `bring` brings it back. `mirror` copies it to b, answers a second ask with the running mirror, and carries a file and a commit across. Pointed at b's data dir, `mirrors` lists that mirror from b's side (copy local, a the other device) and `unmirror` is refused until a accepts b's commands, then removes b's copy only and ends a's session. `mirror --from` does the same from b to a, and a's `unmirror` removes a's copy. |
| mirror to a peer | a copies one of its own worktrees to b and runs the mirror itself. Files and a commit made on b's copy come back to a, and the stop removes b's copy while a's original stays. |
| mirror: gitignored rule, setup on, pause | Setup runs, each side keeps its own ignored files, and tracked work crosses. A paused mirror carries nothing, and resuming carries what was held. |
| mirror: controlled from the other device | b holds the original of a mirror a runs, sees a's session against its worktree, and is refused while a accepts no commands. Granted, b pauses it (a file written meanwhile stays put), resumes it (the file crosses), and stops it unforced: a's copy goes, b's original stays, and b's served stream ends. |
| mirror: diverged stop is refused | Both sides commit while paused. The pair reads diverged with both tips untouched, Stop is refused and changes nothing, and deleting a's copy ends the session on both devices. |
| dialog: mirror with the default switch | Drives the real dialog from the sidebar. The switch is off under Nothing, follows Gitignored to on and back, the running view lists the setup step as skipped, and the mirror it starts runs no setup. |
| dialog: transplant with the switch pinned off | The switch turned off under Gitignored stays off through rule changes, the running view lists setup as skipped, and the transplant runs no setup and brings no ignored file. |
| dialog: transplant with the switch pinned on | The switch turned on under Nothing runs setup, the running view names the setup command, and the copy keeps its own build output. |
| dialog: transplant to a peer | The local page's "Transplant to…" opens on b, its one ready device. The copy lands there with a's edit, and "Tear it down" removes a's source and leaves for the copy's page on b. |
| port forward | a forwards a loopback echo server on b. Bytes round-trip.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| clone onto a peer | a asks b to clone a loopback `git://` remote into b's repos folder and register it. Refused with commands off (the folder listing too), and for an option-shaped string or a path as the URL. The checkout lands, lists with an identity, and its `cloneUrl` reads back, where the path-origin shared repo answers null. A second clone onto the folder is refused.                                                                                                     |
| liveness     | b is killed with SIGKILL. a drops it from the roster. b relaunches and both reconnect.                                                                                                                                                                                                                                                                                                                                                                                      |
| shared settings: offline catch-up | b is killed, a writes a value, b relaunches. b's copy takes the value once its session lands, with no server having held it. |
| revoke       | a removes b from the account. a's roster and registry drop it, and b signs itself out of the account: its hub socket stops, its direct sessions close, the port forward it ran is gone, its mirrors end (copies kept), its shared settings are dropped, and no device tabs remain. a ends its mirror with b too, once its registry read no longer lists b.                                                                                                                                                                                                                                                                 |

Screenshots and logs go to a temp dir named in the output. A failing
scenario screenshots both windows first.

Two mirror checks are still by hand. With a mirror running, relocate
a's local side of it (the worktree the mirror landed there): a's
session is gone from `window.api.mirror.list()`, and b's page for its
own worktree no longer says it is mirrored elsewhere. And a delete the
CLI refuses (dirty tree, no force) leaves the mirror running. The
forced delete is the "diverged stop" scenario above.

Prerequisites:

- The plain dev app signed in once.
- The Go toolchain (for the dev CLI and file-sync engine builds).
- No other `pnpm dev` running from the same worktree. The primary
  needs the renderer port.

To add a scenario, add a `scenario("name", async () => { ... })` block
and assert through the bridge and the disk.

## Screenshotting a UI change

To see a UI change, screenshot it headless on this machine. Don't use
a browser preview that the chat app shows in the thread: that browser
runs on the viewer's machine, and over a remote connection it cannot
reach a dev server here.

```sh
# 1. Start the UI lab (lab/README.md). Pick a free port: other
#    sessions may hold the defaults (5191, and 5192 for lab:web).
pnpm lab --port 5291
# 2. In another terminal, describe the shots and take them.
cat > /tmp/shots.json <<'JSON'
[{ "file": "devices-dark", "query": "?theme=dark&to=/devices" },
 { "file": "phone", "query": "?theme=light", "width": 390, "height": 844 }]
JSON
LAB_ORIGIN=http://localhost:5291/ node lab/shoot.mjs /tmp/shots.json /tmp
```

- `pnpm lab:web` serves the web shell, which renders the phone layout
  under 768px.
- Each shot can click, press, and evaluate before it captures. The
  shot format is in `lab/shoot.mjs`.
- `lab/record.mjs` takes the same input and records a video instead.
- `playwright-core` is a dev dependency, so a one-off script can
  `import { chromium } from "playwright-core"` and launch
  `{ channel: "chrome", headless: true }` for anything the shot format
  can't express.
- For the real app rather than the lab, launch it with a debug port
  and use `drive.mts shot` ([Driving a window over CDP](#driving-a-window-over-cdp)).
- Stop the lab when you're done.

## Other tools

- **UI lab** (`lab/README.md`). The real UI over a fixture bridge with
  four fake devices. Use it to pose and screenshot every multi-device
  surface without a hub or a second device (see
  [Screenshotting a UI change](#screenshotting-a-ui-change)). Visual
  only, no behavior.
  It is also the place to record a video of a flow (`lab/record.mjs`):
  the transfer and mirror verbs are posed there, so a recording shows
  the UI, not a real transfer. A video of the real two-device flow
  needs the profiles above and a screen recorder on the window, and
  `screencapture -v` needs a permission a remote session cannot grant.
- **Web client** (`pnpm web:dev`, port 5190). A third device that
  connects through the tunnel only, so it is the way to test the
  tunnel data path on one machine. Launch the desktop with
  `SM_ACCOUNT_WEB_ORIGIN=http://localhost:5190` so it admits the web
  client. The dev hub needs the tunnel secrets configured. The web
  client is a hostless controller: it is the desktop with no local
  projects, so anything a desktop can do to a peer (browse its
  worktrees, run and watch its scripts, change its settings) works
  from a browser tab the same way, and anything local by nature
  (launch tools, this device's section, port forwarding) is absent.
- **Local hub** (`pnpm -C hub dev`). Set `SM_DEVICE_HUB_URL` to
  `http://localhost:8787` to run against a Worker on this machine
  instead of `hub-dev`. Needs `CLERK_SECRET_KEY` in `hub/.dev.vars`.
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
  the plain dev app's Clerk session may have expired: open `pnpm dev`,
  sign in again, then relaunch the profile. Otherwise sign in from the
  profile's window.
- **A device from an old profile still shows on the Devices page.**
  `--fresh` and quitting do not revoke, and a self sign-out over CDP
  re-enrolls a relaunched window. Revoke it from another device. See
  "Cleaning up after a session".
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
