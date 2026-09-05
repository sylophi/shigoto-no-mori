# Manual testing

How to run the real app, drive it from a script, and test remote
flows on one machine. Written for people and for agents.

The automated checks (`pnpm <name>:check`, `pnpm hub:check`, listed
in `lefthook.yml`) are not covered here.

## Quick start: two devices on one machine

```sh
# 1. Sign the plain dev app in once (Continue with GitHub). Then quit it.
pnpm dev

# 2. Start the primary dev app as profile "a", with a debug port.
SHIGOMORI_DEBUG_PORT=9222 pnpm dev --profile a --fresh --clone-login

# 3. In another terminal, start a second window as profile "b".
SHIGOMORI_DEBUG_PORT=9223 pnpm dev:peer b --fresh --clone-login

# 4. Drive either window from the shell.
node scripts/e2e/drive.mts 9222 eval 'window.api.hub.status()'
node scripts/e2e/drive.mts 9223 shot /tmp/b.png
```

Each window's Devices page should list the other device as online,
then connected. The device names end in `[a]` and `[b]`.

To run every remote flow unattended instead:

```sh
pnpm test:remote-smoke
```

The sections below explain each piece.

## Builds and data folders

The app has two builds. Each keeps its own state.

| | Packaged app | Dev app (`pnpm dev`) |
|---|---|---|
| Data dir | `~/.sm` | `~/.smd` |
| Data dir pointer file | `~/.config/shigomori/data-dir` | `~/.config/shigomori-dev/data-dir` |
| userData (macOS) | `~/Library/Application Support/Shigoto no Mori` | `~/Library/Application Support/Shigoto no Mori (dev)` |
| CLI | `sm` (bundled) | `smd` (`dist-cli/smd`, built by `pnpm dev`) |
| Renderer scheme | `shigomori://app` | `shigomori-dev://app` |
| Hub and Clerk config | Baked in at build time | `.env.local` (`hub-dev.shigomori.com`) |

A device is made of two folders:

- **Data dir.** Projects and worktrees: `registry.json` (projects
  and the device id), `state.json`, `config.json`, `projects/`,
  `worktrees/`. The device id is created per data dir, so one data dir
  is one device. A pre-2.0 `~/shigomori` (`~/shigomori-dev`) that still
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
  different data dirs *and* different userData. Dev profiles (below)
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
  `scripts/e2e/remote-smoke.mts` shows the pattern.

## Running the dev app

`pnpm dev` does the following:

1. Builds the dev CLI (`dist-cli/smd`).
2. Fetches the pinned `cloudflared` binary.
3. Allocates the renderer port (`PORT` in `.env.local`, one per worktree).
4. On macOS, clones Electron into a per-worktree bundle under
   `.electron-dev/` and launches from it, so GitHub sign-in can
   deep-link back. The most recently launched worktree owns the
   `shigomori-dev://` scheme.

### Environment variables

| Variable | Effect |
|---|---|
| `SHIGOMORI_DATA_DIR` | Data dir for this session. See above. |
| `SHIGOMORI_PROFILE` | Dev profile name. The launchers set it, and it requires `SHIGOMORI_DATA_DIR`. |
| `SHIGOMORI_DEBUG_PORT` | Opens Chromium's remote-debugging port on that window. Dev builds only. |
| `PORT` | Renderer dev server port. `.env.local` holds the per-worktree value. |
| `SM_DEVICE_HUB_URL` | Device hub URL. Normally from `.env.local`; a real env var overrides it. |
| `SM_ACCOUNT_CLERK_PUBLISHABLE_KEY` | Clerk key. Same override rule. |
| `SM_ACCOUNT_WEB_ORIGIN` | Web client origin the desktop admits. Same override rule. |
| `SHIGOMORI_UPDATE_FEED_URL` | Alternate update feed for the updater. |

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
# Primary: a full pnpm dev (build, vite server, deep links) running as profile "a".
pnpm dev --profile a [--fresh] [--clone-login]

# Peer: a second window running as profile "b", using the primary's build and vite server.
pnpm dev:peer b [--fresh] [--clone-login]
```

| Flag | Effect |
|---|---|
| `--fresh` | Wipe the profile's folder and userData before launch. |
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
- **Both profiles use the owner's real dev account.** Each enrolls on
  the dev hub and provisions a tunnel. This is intended: the hub,
  Clerk and tunnel provisioning are exercised for real.
- **The tunnel data path is not covered on one machine.** The LAN
  candidate always wins locally. Use the web client (below) for that.

## Driving a window over CDP

Launch any dev window with `SHIGOMORI_DEBUG_PORT=<port>`. Chromium's
remote-debugging endpoint opens on that port. `curl localhost:<port>/json`
lists the targets.

The preload exposes the real IPC bridge as `window.api` in the page.
Drive the window by calling the bridge and assert on the results, not
on the DOM.

### Shell driver

```sh
node scripts/e2e/drive.mts <port> eval '<expression>'
node scripts/e2e/drive.mts <port> wait '<expression>' [timeoutMs]
node scripts/e2e/drive.mts <port> shot <file.png>
```

- `eval` awaits the expression and prints the result as JSON.
- `wait` polls until the expression is truthy.
- `shot` writes a PNG of the window.

Examples:

```sh
node scripts/e2e/drive.mts 9222 eval 'window.api.hub.status()'
node scripts/e2e/drive.mts 9222 eval 'window.api.account.status()'
node scripts/e2e/drive.mts 9222 wait 'window.api.account.status().then(s => s.signedIn)' 60000
node scripts/e2e/drive.mts 9222 shot /tmp/window.png
```

For scripted use, `scripts/e2e/cdp.mts` exports `attachWindow`, which
returns a window with `evaluate`, `waitFor`, `screenshot` and `close`.

### Useful bridge calls

| Call | Returns |
|---|---|
| `window.api.deviceId` | This window's device id. |
| `window.api.account.status()` | `signedIn`, `accountId`, `deviceName`, `configured`. |
| `window.api.account.listDevices()` | The account's device registry from the hub, with `online`. |
| `window.api.account.setAcceptsCommands(bool)` | Flips this device's command grant. |
| `window.api.account.signOut()` | Revokes this device and clears the credential. Clerk is untouched. |
| `window.api.hub.status()` | Socket phase, `onlineDeviceIds`, `peerAppVersions` (one key per direct session), `tunnel`. |
| `window.api.hub.invokePeer({deviceId, channel, input})` | Any host call on a peer, e.g. `projects:list`, `worktrees:list`, `worktrees:create`. |
| `window.api.sync.pullWorktree({...})` | Brings a peer's worktree here. See the smoke for the payload. |
| `window.api.sync.teardownSource({...})` | Second half of a transplant. |
| `window.api.portForward.start({deviceId, remotePort})` | Forwards a peer's loopback port. Returns `localPort`. |
| `window.api.mirror.start({...})` | Brings a peer's worktree here and keeps the two mirrored (files both ways, git state followed). Same payload as `sync.pullWorktree`. Returns the local worktree and the `session`. |
| `window.api.mirror.list()` | This device's mirror sessions (`status`, `git.status`, conflicts) and the streams it serves for peers. |
| `window.api.mirror.stop(session)` / `pause` / `resume` | Controls a session this device runs. |

### Two argument conventions

- `window.api.<module>.<call>` uses the renderer's signature, defined
  per call in `shared/ipc/client.ts`. Some calls take positional
  arguments, e.g. `portForward.stop(forwardId)` and
  `ports.list(projectId, worktreeId)`.
- `hub.invokePeer` and the check scripts use the raw contract payload
  from `shared/ipc/modules/<module>.ts`.

A rejection with a zod issue list means the payload shape matches the
wrong convention.

### DOM hooks

Use the DOM only where a person would click. The sidebar's Devices
button has `aria-label="Devices"`. Clerk's modal is plain DOM in the
page, with `.cl-*` classes.

## Unattended remote smoke

```sh
pnpm test:remote-smoke [--keep]
```

`scripts/e2e/remote-smoke.mts` runs the full remote loop with no
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

| Scenario | Asserts |
|---|---|
| presence | Each roster holds the other. a's registry shows b online. |
| remote read | a lists b's projects and the main worktree of `shared`. |
| grant gate | With b's switch off, a's `worktrees:create` on b is refused with the typed message. With it on, `feat/e2e` is created and the path exists on disk. |
| bring here | a pulls `feat/e2e`. The worktree lands under a's data dir on that branch. |
| transplant | a tears the source down. It is gone from b's disk and still present on a. |
| mirror | a mirrors a fresh worktree of b's. Files written on either side land on the other, a gitignored file included. A commit on b lands on a with the same tip and a clean status. Stopping clears a's session and b's served stream. |
| port forward | a forwards a loopback echo server on b. Bytes round-trip. |
| liveness | b is killed with SIGKILL. a drops it from the roster. b relaunches and both reconnect. |
| sign-out | b revokes itself. a's roster and registry drop it. |

Screenshots and logs go to a temp dir named in the output. A failing
scenario screenshots both windows first.

Prerequisites:

- The plain dev app signed in once.
- The Go toolchain (for the dev CLI and file-sync engine builds).
- No other `pnpm dev` running from the same worktree. The primary
  needs the renderer port.

To add a scenario, add a `scenario("name", async () => { ... })` block
and assert through the bridge and the disk.

## Other tools

- **UI lab** (`lab/README.md`). The real UI over a fixture bridge with
  four fake devices. Use it to pose and screenshot every multi-device
  surface without a hub or a second device. Visual only, no behavior.
- **Web client** (`pnpm web:dev`, port 5190). A third device that
  connects through the tunnel only, so it is the way to test the
  tunnel data path on one machine. Launch the desktop with
  `SM_ACCOUNT_WEB_ORIGIN=http://localhost:5190` so it admits the web
  client. The dev hub needs the tunnel secrets configured.
- **Local hub** (`pnpm -C hub dev`). Set `SM_DEVICE_HUB_URL` to
  `http://localhost:8787` to run against a Worker on this machine
  instead of `hub-dev`. Needs `CLERK_SECRET_KEY` in `hub/.dev.vars`.
- **Packaged build** (`pnpm make`). The only way to test the prod
  scheme registration and the real keychain.

## Troubleshooting

- **Blank window, `net::ERR_NETWORK_CHANGED` repeating in the log.**
  The renderer proxy lost the vite dev server while the network
  changed. Relaunch.
- **Second `pnpm dev` fails.** From the same worktree it fails on the
  renderer port. From another worktree it exits at the single-instance
  lock unless it runs as a profile.
- **Profile boots signed out after `--clone-login`.** On Linux and
  Windows the copied token store cannot be decrypted. Sign in from the
  profile's window instead.
- **A revoked device still shows on the Devices page.** `--fresh` does
  not revoke. Revoke it from another device's Devices page.
- **`smd` in a new terminal acts on the plain dev data dir.** To
  target a profile from the shell, set its data dir first:
  `SHIGOMORI_DATA_DIR=~/.smd-profiles/<name>/data smd ...`.
- **Dev tokens on macOS.** They sit under Chromium's mock keychain,
  obfuscated but not protected. This is what makes `--clone-login`
  possible and is fine on the owner's machine.
