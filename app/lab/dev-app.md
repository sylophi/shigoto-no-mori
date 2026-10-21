# The dev app

How the dev app is built, where it keeps its state, and how dev
profiles make several devices of one machine. The reference behind
`devices.md`.

## Builds and data folders

The app has three builds, its flavors: prod is what ships, v3 is an
alpha, beta or rc of 3.0.0 (`v3.0.0-alpha.N`, `-beta.N`, `-rc.N`) the owner
runs beside prod until v3 merges into main, and dev is `pnpm dev`.
Each keeps its own state and never reads another's, so all three run on
one machine at once as three devices. A test flavor, a packaged build
under a word of its own, is a fourth that is thrown away after its
test (Packaged build, as a test flavor, below). Every name below comes from one
table, `packages/engine/src/flavor.ts`. A packaged build's flavor is
baked in when it is built (`SM_FLAVOR`, which the release workflow
sets from the tag) and main reads it in one place (`main/flavor.ts`),
which hands it to the host.

|                       | Prod                                            | v3                                                     | Dev (`pnpm dev`)                                      |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| App and dock name     | Shigoto no Mori                                 | Shigoto no Mori (v3)                                 | Shigoto no Mori (Dev)                                 |
| Bundle id             | `com.sylophi.shigomori`                         | `com.sylophi.shigomori.v3`                           | `com.sylophi.shigomori.dev.<worktree>`                |
| Renderer scheme       | `shigomori://app`                               | `shigomori-v3://app`                                 | `shigomori-dev://app`                                 |
| Data dir              | `~/.sm`                                         | `~/.smv3`                                              | `~/.smd`                                              |
| On a project's drive  | `/Volumes/<drive>/.sm/wt`                       | `/Volumes/<drive>/.smv3/wt`                            | `/Volumes/<drive>/.smd/wt`                            |
| Data dir pointer file | `~/.config/shigomori/data-dir`                  | `~/.config/shigomori-v3/data-dir`                      | `~/.config/shigomori-dev/data-dir`                    |
| userData (macOS)      | `~/Library/Application Support/Shigoto no Mori` | `~/Library/Application Support/Shigoto no Mori (v3)` | `~/Library/Application Support/Shigoto no Mori (dev)` |
| Logs                  | `~/Library/Logs/Shigoto no Mori/`               | `~/Library/Logs/Shigoto no Mori (v3)/`               | `~/Library/Logs/Shigoto no Mori (Dev)/`, a profile's with ` [<profile>]` |
| Keychain item         | `Shigoto no Mori Safe Storage`                  | `Shigoto no Mori (v3) Safe Storage`                  | none on macOS (mock keychain)                         |
| file-sync state       | `<data dir>/file-sync`                          | `<data dir>/file-sync`                                 | `<data dir>/file-sync`                                |
| Single-instance lock  | in its userData                                 | in its userData                                        | in its userData                                       |
| CLI                   | `sm`, `shigomori` (bundled)                     | `smv3`, `shigomori-v3` (bundled)                       | `smd`, `shigomori-dev` (`dist-cli/smd`)               |
| Updates               | full releases, and its own rc line              | the v3 prereleases alone                               | none                                                  |
| Hub and Clerk config  | Baked in at build time                          | Baked in at build time (the dev hub, `SM_PREVIEW_` variables)  | `.env.local` (`hub-dev.shigomori.com`)                |

A v3 build's terminal command, shell hook and agent hooks are its
own (`smv3`, markers and entries named for `shigomori-v3`), beside
prod's, so dogfooding v3 leaves the installed `sm` alone. It starts on
an empty `~/.smv3`: the v3 migration imports what v2 left in a data
dir, and a v3 build has none. The v3 flavor, its repo variables and
its Clerk origin go when v3 merges into main.

Settings' Danger zone (Nuke everything) returns a build to a fresh
install: its worktrees, its `sm` links and hooks, its device on the
hub, and then, at the next start, everything in the rows above but the
lock, the bundle and the scheme. On the plain dev instance it leaves
the profiles in its userData alone.

A device is made of two folders:

- **Data dir.** Projects and worktrees: `store.db` (the SQLite store:
  projects, the device id, settings, marks and state), `wt/` (the
  managed worktrees), `file-sync/`, and while the app runs
  `loopback.json` (how the terminal's cross-device verbs find it). The
  device id is created per data dir, so one data dir is one device. A
  v2 data dir's `registry.json`, `state.json`, `config.json` and
  `projects/` are imported into the store once and deleted once the
  store is verified to hold them; its `worktrees/` move to `wt/`. Prod
  adopts a pre-2.0 `~/shigomori` that still holds state in place until
  `~/.sm` holds state; Settings > Data location offers to rename it,
  and `sm doctor` warns.
- **userData.** The app instance: `account.json` (hub credential and
  the accept-commands switch), `clientConfig.json` (theme,
  keep reachable, keybindings), `clerk-tokens.json` (Clerk session),
  `windows.json` (the windows to reopen), `direct-port` (the
  listener's port, kept across restarts), `cloudflared.pid`. Sign-in state lives here, not in the data dir. It
  also holds the single-instance lock, so only one app can run per
  userData.

The logs folder holds `main.log`, the main process's log, and
`trace.log`, one JSON line for every span that ended (its name, ids,
duration, outcome and attributes).

## Changing where the data lives

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


## Filling a data dir with test repos

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
  (wipe stale profiles by hand first, see `devices.md`, "Cleaning up"):

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

## Running the dev app

`pnpm dev` (and the primary `pnpm device`) does the following:

1. Builds the dev CLI (`dist-cli/smd`).
2. Fetches the pinned `cloudflared` binary.
3. Allocates this worktree's dev server ports with port-pool (into
   `.env.ports`): the renderer's `RENDERER_PORT`, plus `WEB_PORT`,
   `FAKE_HOST_PORT` and `FAKE_HOST_WEB_PORT` for `pnpm web:dev`,
   `pnpm fake-host` and `pnpm fake-host:web`, which run the same step.
   When the pool's port names change, a checkout's ports are
   allocated afresh, which can move them; a line the pool doesn't
   write stays in `.env.ports`, unread.
4. On macOS, clones Electron into a per-worktree bundle under
   `.electron-dev/` and launches from it, so GitHub sign-in can
   deep-link back. The most recently launched worktree owns the
   `shigomori-dev://` scheme.

Flags the profile options don't take go on to electron-forge, so
`pnpm dev --profile <name> --inspect-electron` starts the main process
under Node's inspector. `pnpm device` takes only its own flags.

The native menu, the dock and the system dialogs are outside any page.
weblab drives them through the main process: a session that attaches
to the window with `mainProcess` set runs an `electron` step there, so
walking `Menu.getApplicationMenu().items` to an item by its label and
calling its `click` is a step like any other. Shoot the attached window (`shot`), not the
screen, which an agent's session has no permission to capture.

## Environment variables

| Variable                           | Effect                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `SHIGOMORI_DATA_DIR`               | Data dir for this session. See above.                                         |
| `SHIGOMORI_PROFILE`                | Dev profile name. The launchers set it, and it requires `SHIGOMORI_DATA_DIR`. |
| `SHIGOMORI_DEBUG_PORT`             | Opens Chromium's remote-debugging port on that window. Dev builds only.       |
| `SHIGOMORI_DIAL_KINDS`             | Candidate kinds this device dials, e.g. `tunnel`. Dev builds only. See Rules. |
| `SHIGOMORI_DIRECT_FRONT_PORT`      | Port this device advertises for its direct listener (LAN candidates, the tunnel's ingress), for a proxy in front of it. Dev builds only. |
| `SHIGOMORI_DEVTOOLS`               | `1` streams the main process's spans to the Effect devtools (VS Code) on their default port. Dev builds only. |
| `RENDERER_PORT`                    | Renderer port, from `.env.ports`. A real env var overrides it.                |
| `WEB_PORT`                         | Web client port (`pnpm web:dev`). Same source and override rule.              |
| `FAKE_HOST_PORT`, `FAKE_HOST_WEB_PORT` | Fake host ports (`pnpm fake-host`, `pnpm fake-host:web`). Same source and override rule. |
| `SM_DEVICE_HUB_URL`                | Device hub URL. Normally from `.env.local`; a real env var overrides it.      |
| `SM_ACCOUNT_CLERK_PUBLISHABLE_KEY` | Clerk key. Same override rule.                                                |
| `SM_ACCOUNT_WEB_ORIGIN`            | Web client origin the desktop admits. Same override rule.                     |
| `SHIGOMORI_UPDATE_FEED_URL`        | App only. Stand-in for the update server, the fallback for the release list. |
| `SHIGOMORI_UPDATE_RELEASES_URL`    | App only. Stand-in for the GitHub release list.                              |

`.env.local` holds the dev hub's URL and the dev Clerk instance's
publishable key, neither a secret, and is not in the repo: a worktree
`sm` makes carries it over from the primary checkout (the project's
carry-over setting), and a checkout made any other way copies it from
there. Without both values the account reads as unconfigured: the
web client never dials its hub socket, Sign in stays off, and the
migration's page leaves its sign-in step out.

The app passes the two update stand-ins to its own update check and
removes them from its environment, so scripts it runs don't inherit
them. `sm update` refuses to run with either set. From a terminal,
pass them to the command instead: `sm update --feed-url <url>` or
`--releases-url <url>`. Either one keeps the check off both real endpoints.


## Theme hotkeys

In a dev build, `Ctrl+T` toggles light/dark, `Ctrl+D` toggles
doubutsu, `Ctrl+P` cycles the current appearance's doubutsu palette,
and `Ctrl+R` resets to the saved theme. These are previews and are not
saved.


## Dev profiles

Every remote flow needs a second device. A **dev profile** is an extra
dev instance on this machine with its own data dir, userData, device id
and sign-in. Two profiles are two devices on the hub. They connect to
each other over the LAN.

```
~/.smd-profiles/<name>/data    data dir
~/.smd-profiles/<name>/repos   test repos for the profile
<dev userData>/profiles/<name>          userData
```

Profile names are lowercase letters, digits and dashes, up to 32
characters. `scripts/lib/devProfile.mts` owns the layout.


`pnpm device <name>` runs one (`pnpm dev --profile <name>` too, for a
primary in a terminal).

| Flag            | Effect                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--fresh`       | Wipe the profile's folder and userData before launch.                                                                                 |
| `--clone-login` | Copy the plain dev app's Clerk sign-in into the profile. The profile boots signed in and enrolls as a new device on the same account. |

## Signing a profile in

The plain dev app (`pnpm dev` without a profile) must be signed in
once before `--clone-login` works, and stay signed in: its Clerk
session can lapse while its device credential lives on, and then it
still reads signed in while every clone boots signed out (see
`devices.md`, "Troubleshooting"). Cloning only works on macOS. Linux
and Windows key the dev token store per app name, so the copied file
decrypts to nothing and the profile boots signed out.

Without `--clone-login`, sign in from the profile's own window using a
method that stays in the window. GitHub sign-in uses a deep link, and
with two windows from the same bundle the OS picks which one receives
it. The Clerk dev instance offers GitHub only, hence cloning.

## Rules

- **A data folder move restarts the app through the launcher.** The
  app touches a marker and quits, and `pnpm dev` starts forge again
  (vite included) instead of leaving a detached Electron on a dead
  renderer. The peer relaunches itself, and its wrapper exits.
- **A main-process change restarts nothing by itself.** Forge rebuilds
  the main bundle (it prints `target built`) but leaves the primary
  running on the old code: type `rs` in the `pnpm start` terminal to
  restart it. The peer keeps the code it booted with until it is
  relaunched.
- **An edit to a workspace package doesn't reach a running window.**
  The renderer's dev server serves `packages/ui` under its
  `node_modules` link (`/node_modules/@shigomori/ui/src/…`, and
  `contracts` the same way, not tried), and its watcher never
  invalidates those modules: the old file is served after a reload
  too. Stop the window, remove `node_modules/.vite` and start it again.
  `ui` is also prebundled (`optimizeDeps` excludes only `contracts`
  and `effect`); excluding it serves it as source but changes nothing
  else, and neither does un-ignoring the links in
  `server.watch.ignored`: the cause is in how vite resolves the links.
- **The host is a process of its own** (`main/hostProcess.ts` forks
  `host/process/host.ts`), and its log lines come prefixed `[host]`.
  Killing it is a crash the shell recovers from: it forks the host
  again, on the bundle built last, and the window redials. That is
  also the quick way to run a host change.
- **Never press Sign out in a cloned window.** A cloned sign-in shares
  one Clerk client with the plain dev app, so signing out ends the
  session for both. End a cloned profile by revoking its device
  instead: run `api.run(api.account.signOut())` in a `js` step
  (`bridge.md` says how a step reaches `api`), or use the account
  page of another device. Then run with `--fresh` or delete the
  folders.
- **`--fresh` is local only.** A device the profile enrolled stays on
  the hub, with its tunnel, until revoked. Leftovers show on the
  account page of any device on the account and can be revoked there.
  See `devices.md`, "Cleaning up". A sign-out that could not reach
  the hub (offline, hub down) parks its revoke in the signed-out
  envelope and delivers it on the next launch or the next sign-in, so
  a leftover from an offline sign-out clears itself once the profile
  runs online again.
- **A device revoked while it was off** learns it on its next launch:
  the hub answers its dead credential with a typed "device revoked"
  (a tombstone, `hub/migrations/0002_revoked_credentials.sql`), and
  the app signs out exactly as if it had been online for the revoke.
- **Both profiles use the owner's real dev account.** Each enrolls on
  the dev hub and provisions a tunnel. This is intended: the hub,
  Clerk and tunnel provisioning are exercised for real.
- **The tunnel data path needs asking for on one machine.** The LAN
  candidate always wins locally. Launch one profile with
  `SHIGOMORI_DIAL_KINDS=tunnel` and its session to the other rides that
  device's tunnel, the way a web client's does. The dev hub needs the
  tunnel secrets configured. The web
  client (below) is the other way.




## When a device is removed

A device removed from the account while it runs signs itself out: a
packaged or plain dev app ends its Clerk session too and lands on the
signed-out account page, while a profile that holds a cloned sign-in
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
the next sign-in. The devices that stay end their mirrors with the
removed one the next time they read the registry. A relaunch after
`--fresh` is a new device.

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
  (launch tools, this device's settings, port forwarding) is absent.
- **Local hub** (`pnpm -C ../hub dev`). Set `SM_DEVICE_HUB_URL` to
  `http://localhost:8787` to run against a Worker on this machine
  instead of `hub-dev`. Needs `CLERK_SECRET_KEY` in the repo root's
  `hub/.dev.vars`, see `hub/README.md`, "Develop and test".
- **Packaged build, as a test flavor** (`SM_FLAVOR=<word> pnpm
  package`, `lab` by convention). A word that is no build's makes a
  test flavor: every name follows from it (`Shigoto no Mori (lab)`,
  `com.sylophi.shigomori.lab`, `shigomori-lab://`, `~/.smlab`,
  `smlab`; `packages/engine/src/flavor.ts` `derive`), so it runs
  beside the installed apps and the dev app and shares nothing with
  them (`packages/engine/src/footprint.ts` lists what it puts on the
  machine). It has no updates and no login item, is never signed with
  a Developer ID (forge refuses with `APPLE_SIGNING_IDENTITY` set), so
  runs on the mock keychain, and takes a debugging port as the dev app
  does. It can't sign in: Clerk's dev instance refuses its scheme's
  origin (`origin_authorization_headers_conflict`), so a flow that
  needs an account runs on a dev profile instead:

  ```sh
  SM_FLAVOR=lab pnpm package
  node scripts/smoke-app.mts "out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app" --serve 9341
  # weblab: new { "name": "lab", "attach": "127.0.0.1:9341", "dir": "<this checkout>" }
  "out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app/Contents/Resources/smlab" nuke --yes
  ```

  The smoke opens the store on two fresh data folders, then with
  `--serve` leaves the app up on a third with the port open until it
  is stopped, and deletes that folder. `smlab nuke --yes` then takes
  everything of the build off the machine, its bundle too.
- **Packaged prod or v3 build** (`pnpm make`, `SM_FLAVOR=v3` for a v3
  one). The only way to test a packaged scheme registration under the
  real names. Without `APPLE_SIGNING_IDENTITY` in the build
  environment the bundle is unsigned and, like dev, runs on
  Chromium's mock keychain: the real keychain is exercised only by a
  Developer-ID-signed build (the release workflow). A local prod
  build shares the installed app's userData, and tokens it writes are
  under the mock key, so switching between it and the installed app
  signs the other out once. It takes no debugging port: it quits when
  started with `--remote-debugging-port` or `--remote-debugging-pipe`
  (`main/electron/debugSwitches.ts`). Read and drive its window
  through macOS accessibility instead, asking the app for its page's
  tree by setting `AXManualAccessibility` once the page is up
  (`lab/relaunch.mts`), and read `main.log`. It ignores `--sm-lab`.
  `node scripts/smoke-app.mts <the .app>` launches it on fresh data
  folders and waits for its store to open, as the release job does.
  With `APPLE_SIGNING_IDENTITY` set and the build signed by it, it then
  has the app update itself into a copy signed again under a newer
  version, as the release job does too. Its launches write the build's
  userData and logs folder, and a build of a flavor whose app is
  running on this machine quits at its single-instance lock.
