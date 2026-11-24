# The dev app

How the dev app is built, where it stores its state, and how dev profiles let one machine act as multiple devices. This is the reference behind [`devices.md`](devices.md).

## Builds and data folders

The app has two builds, called flavors: prod is what ships, and dev is what `pnpm dev` runs. Each flavor stores its own state and never reads the other's, so both can run on the same machine at once as two separate devices. A test flavor (a packaged build named with a custom word) is a third flavor that is discarded after its test (see "Packaged build, as a test flavor" below).

Every name below comes from one table in [`packages/engine/src/flavor.ts`](../../packages/engine/src/flavor.ts). A packaged build's flavor is baked in at build time via `SM_FLAVOR` (unset for prod, which is what the release workflow builds). The main process reads it in one place ([`main/flavor.ts`](../main/flavor.ts)) and passes it to the host.

|                       | Prod                                            | Dev (`pnpm dev`)                                                         |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| App and dock name     | Shigoto no Mori                                 | Shigoto no Mori (Dev)                                                    |
| Bundle id             | `com.sylophi.shigomori`                         | `com.sylophi.shigomori.dev.<worktree>`                                   |
| Renderer scheme       | `shigomori://app`                               | `shigomori-dev://app`                                                    |
| Data dir              | `~/.sm`                                         | `~/.smd`                                                                 |
| On a project's drive  | `/Volumes/<drive>/.sm/wt`                       | `/Volumes/<drive>/.smd/wt`                                               |
| Data dir pointer file | `~/.config/shigomori/data-dir`                  | `~/.config/shigomori-dev/data-dir`                                       |
| userData (macOS)      | `~/Library/Application Support/Shigoto no Mori` | `~/Library/Application Support/Shigoto no Mori (dev)`                    |
| Logs (macOS)          | `~/Library/Logs/Shigoto no Mori/`               | `~/Library/Logs/Shigoto no Mori (Dev)/` (profiles append ` [<profile>]`) |
| Keychain item         | `Shigoto no Mori Safe Storage`                  | none on macOS (mock keychain)                                            |
| file-sync state       | `<data dir>/file-sync`                          | `<data dir>/file-sync`                                                   |
| Single-instance lock  | in its userData                                 | in its userData                                                          |
| CLI                   | `sm`, `shigomori` (bundled)                     | `smd`, `shigomori-dev` (`dist-cli/smd`)                                  |
| Updates               | the app's releases                              | none                                                                     |
| Hub and Clerk config  | Baked in at build time                          | `.env.local` (`hub.colibrii.link`)                                       |

"Nuke everything" in Settings > Danger zone returns a build to a fresh install. It removes the build's worktrees, removes its `sm` links and hooks, and revokes its device on the hub. Then, on the next start, it deletes everything in the table above except the lock, the bundle, and the scheme. On the plain dev instance, it leaves the profiles in its `userData` alone.

A device is made of two folders:

- **Data dir.** Stores projects and worktrees: `store.db` (the SQLite store for projects, the device id, settings, marks, and state), `wt/` (the managed worktrees), `file-sync/`, and while the app runs, `loopback.json` (which the terminal's cross-device verbs use to find the running app). The device id is created per data dir, so one data dir is one device. For a v2 data dir, `registry.json`, `state.json`, `config.json`, and `projects/` are imported into the store once and deleted once the store is verified to contain them, and `worktrees/` moves to `wt/`. Prod adopts a pre-2.0 `~/shigomori` folder in place while it still contains state and `~/.sm` does not. Settings > Data location offers to rename it, and `sm doctor` warns about it.
- **userData.** Stores app-instance state: `colibrii.json` (the device's enrollment on the account service and its listener port, sealed with `device-store-key` from the OS keychain, or plain on Linux), `account.json` (the device's name, icon choice, and accept-commands switch), `clientConfig.json` (theme, keep reachable, keybindings), `clerk-tokens.json` (Clerk session), `windows.json` (windows to reopen), and `cloudflared.pid`. Sign-in state lives here, not in the data dir. `userData` also stores the single-instance lock, so only one app can run per `userData` folder.

The logs folder contains `main.log` (the main process's log) and `trace.log` (one JSON line for every span that ended, recording its name, ids, duration, outcome, and attributes).

## Changing where the data lives

- `SHIGOMORI_DATA_DIR=<dir> pnpm dev` sets `<dir>` as the data dir for that session only. Both the app and every CLI child process it spawns use this path. Moving the data dir from Settings is disabled during such a session.
- The **data dir pointer file** contains a single absolute path and relocates the build's data dir permanently. The app writes this file when you move the data folder from Settings, and you can also edit it by hand. The target directory must be missing, empty, or already contain shigomori state, or the pointer file is ignored.
- Neither option changes `userData`. Two devices on one machine need different data dirs _and_ different `userData` folders. Dev profiles (below) provide both.

## Filling a data dir with test repos

There is no shared fixture. Create the repos a test needs with `git init` and `git commit`, then register every repo under a directory in one call:

```sh
smd projects add <dir> --all --yes     # set SHIGOMORI_DATA_DIR if the data dir is sandboxed
```

- Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` so commits do not depend on the machine's git config.
- A worktree can only be pulled between devices that have the same repo, matched by root commit. Clone one seed repo into both profiles instead of creating it twice. Seed both profiles before starting their windows, and start them without `--fresh`, which would wipe what you seeded (wipe stale profiles by hand first, as [`devices.md`](devices.md) describes under "Cleaning up"):

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

`pnpm dev` (and the primary `pnpm device`) runs these steps:

1. Builds the dev CLI (`dist-cli/smd`).
2. Fetches the pinned `cloudflared` binary.
3. Allocates this worktree's dev server ports into `.env.ports` with port-pool: the renderer's `RENDERER_PORT`, plus `WEB_PORT`, `FAKE_HOST_PORT`, and `FAKE_HOST_WEB_PORT` for `pnpm web:dev`, `pnpm fake-host`, and `pnpm fake-host:web`, which run the same step. When the pool's port names change, a checkout's ports are allocated afresh, which can move them. Any line that port-pool does not write stays in `.env.ports`, unread.
4. On macOS, clones Electron into a per-worktree bundle under `.electron-dev/` and launches from it so GitHub sign-in can deep-link back. The most recently launched worktree owns the `shigomori-dev://` scheme.

Flags that the profile options do not consume are passed on to electron-forge, so `pnpm dev --profile <name> --inspect-electron` starts the main process under Node's inspector. `pnpm device` takes only its own flags.

The native menu, the dock, and system dialogs live outside any web page. weblab drives them through the main process: a session attached to the window with `mainProcess` set can run an `electron` step in the main process, so walking `Menu.getApplicationMenu().items` to an item by its label and calling its `click` works like any other step. Capture the attached window (`shot`), not the screen, because an agent's session has no permission to capture the screen.

## Environment variables

| Variable                               | Effect                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHIGOMORI_DATA_DIR`                   | Data dir for this session. See above.                                                                                                       |
| `SHIGOMORI_PROFILE`                    | Dev profile name. The launchers set it, and it requires `SHIGOMORI_DATA_DIR`.                                                               |
| `SHIGOMORI_DEBUG_PORT`                 | Opens Chromium's remote-debugging port on that window. Dev builds only.                                                                     |
| `SHIGOMORI_DEVTOOLS`                   | `1` streams the main process's spans to the Effect devtools (VS Code) on their default port. Dev builds only.                               |
| `SHIGOMORI_DIAL_KINDS`                 | Candidate kinds this device dials, e.g. `tunnel`. Dev builds only. See "Rules".                                                             |
| `SHIGOMORI_DIRECT_FRONT_PORT`          | Port this device advertises for its listener (LAN candidates and the tunnel's ingress), used when a proxy sits in front of it. Dev builds only. |
| `SHIGOMORI_CODE_SIGN_IN`               | `1` signs the window in with a code approved on another device, for an unattended window (see [`devices.md`](devices.md)).                  |
| `RENDERER_PORT`                        | Renderer port, from `.env.ports`. A real env var overrides it.                                                                              |
| `WEB_PORT`                             | Web client port (`pnpm web:dev`). Same source and override rule.                                                                            |
| `FAKE_HOST_PORT`, `FAKE_HOST_WEB_PORT` | Fake host ports (`pnpm fake-host`, `pnpm fake-host:web`). Same source and override rule.                                                    |
| `SM_DEVICE_HUB_URL`                    | The Colibrii instance's hub address. Normally from `.env.local`, but a real env var overrides it.                                           |
| `SM_DEVICE_HUB_APP`                    | The app's id on that instance (`shigomori-dev` in dev). Same override rule.                                                                 |
| `SM_ACCOUNT_CLERK_PUBLISHABLE_KEY`     | Clerk key. Same override rule.                                                                                                              |
| `SM_ACCOUNT_WEB_ORIGIN`                | Web client origin that the desktop app admits. Same override rule.                                                                          |
| `SHIGOMORI_UPDATE_FEED_URL`            | App only. Replacement URL for the update server (the fallback for the release list).                                                        |
| `SHIGOMORI_UPDATE_RELEASES_URL`        | App only. Replacement URL for the GitHub release list.                                                                                      |

`.env.local` stores three values: the Colibrii instance's address, the app's id on that instance, and the dev Clerk instance's publishable key. None of these three is a secret, and `.env.local` is not checked into the repo. A worktree that `sm` creates carries `.env.local` over from the primary checkout (via the project's carry-over setting). A checkout created any other way must copy it from the primary checkout. Without all three values, the account is treated as unconfigured: the web client never dials its hub socket, Sign in stays off, and the migration page omits its sign-in step.

The app passes `SHIGOMORI_UPDATE_FEED_URL` and `SHIGOMORI_UPDATE_RELEASES_URL` to its own update check and removes them from its environment so scripts it runs do not inherit them. `sm update` refuses to run with either variable set. From a terminal, pass them as command flags instead: `sm update --feed-url <url>` or `--releases-url <url>`. Setting either one keeps the check off both real endpoints.

## Theme hotkeys

In a dev build, `Ctrl+T` toggles light/dark, `Ctrl+D` toggles doubutsu, `Ctrl+P` cycles the current appearance's doubutsu palette, and `Ctrl+R` resets to the saved theme. These changes are previews and are not saved.

## Dev profiles

Every remote flow needs a second device. A **dev profile** is an extra dev instance on this machine with its own data dir, `userData`, device id, and sign-in. Two profiles act as two devices on the hub and connect to each other over the LAN.

```
~/.smd-profiles/<name>/data             data dir
~/.smd-profiles/<name>/repos            test repos for the profile
<dev userData>/profiles/<name>          userData
```

Profile names are lowercase letters, digits, and dashes, up to 32 characters. [`scripts/lib/devProfile.mts`](../scripts/lib/devProfile.mts) defines this layout.

Launch a profile with `pnpm device <name>` (or `pnpm dev --profile <name>` when running a primary in a terminal).

| Flag            | Effect                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--fresh`       | Wipe the profile's folder and `userData` before launch.                                                                               |
| `--clone-login` | Copy the plain dev app's Clerk sign-in into the profile. The profile boots signed in and enrolls as a new device on the same account. |

## Signing a profile in

The plain dev app (`pnpm dev` without a profile) must be signed in once before `--clone-login` works, and it must stay signed in. Its Clerk session can lapse while its device credential lives on. When that happens, the plain dev app still appears signed in while every clone boots signed out (see [`devices.md`](devices.md), "Troubleshooting").

Without `--clone-login`, sign in from the profile's own window using a method that stays inside the window. GitHub sign-in uses a deep link, and when two windows run from the same bundle, the OS picks which window receives it. Because the Clerk dev instance offers GitHub only, profiles normally use cloning. Alternatively, a window started with `SHIGOMORI_CODE_SIGN_IN=1` signs in with a code approved on another device (see [`devices.md`](devices.md)).

## Rules

- **A data folder move restarts the app through the launcher.** The app touches a marker and quits, and `pnpm dev` starts forge again (Vite included) instead of leaving a detached Electron process on a dead renderer. A peer relaunches itself, and its wrapper exits.
- **A main-process change does not restart the app by itself.** Forge rebuilds the main bundle (printing `target built`) but leaves the primary running on the old code. Type `rs` in the `pnpm start` terminal to restart it. Peer windows keep the code they booted with until they are relaunched.
- **An edit to a workspace package does not reach a running window.** The renderer's dev server serves `packages/ui` through its `node_modules` link (`/node_modules/@shigomori/ui/src/…`, and `contracts` works the same way, though not tested), and its watcher never invalidates those modules, so the old file is still served after a reload. Stop the window, remove `node_modules/.vite`, and start it again. `ui` is also prebundled (`optimizeDeps` excludes only `contracts` and `effect`). Excluding `ui` serves it as source but changes nothing else, and neither does un-ignoring the links in `server.watch.ignored`: the cause is how Vite resolves those links.
- **The host runs as its own process.** [`main/hostProcess.ts`](../main/hostProcess.ts) forks [`host/process/host.ts`](../host/process/host.ts), and its log lines are prefixed with `[host]`. Killing it simulates a crash that the shell recovers from: the shell forks the host again on the most recently built bundle, and the window redials. Killing the host is also the quickest way to run a host change.
- **Never press Sign out in a cloned window.** A cloned sign-in shares one Clerk client with the plain dev app, so signing out ends the session for both. End a cloned profile by revoking its device instead: run `api.run(api.account.signOut())` in a `js` step (see [`bridge.md`](bridge.md) for how a step reaches `api`), or revoke it from another device's account page. Then run with `--fresh` or delete the profile folders.
- **`--fresh` is local only.** Any device the profile enrolled stays on the hub along with its tunnel until revoked. Leftovers appear on the account page of any device on the account and can be revoked there (see [`devices.md`](devices.md), "Cleaning up"). A sign-out made offline (or with the hub down) defers its removal until the device reaches the hub, so deleting a profile before then also leaves its device on the account.
- **A device revoked while offline** learns about it on its next launch: the hub rejects its credential as removed, and the app signs out just as if it had been online for the revoke.
- **Both profiles use the owner's real dev account.** Each enrolls on the dev hub and provisions a tunnel. This is intended so that the hub, Clerk, and tunnel provisioning are exercised for real.
- **Testing the tunnel data path on one machine requires opting in.** Between two desktops on the same machine, the LAN candidate always wins. Launch one profile with `SHIGOMORI_DIAL_KINDS=tunnel` so its connection to the other desktop goes through that device's tunnel, the way a web client's connection does (see below).

## When a device is removed

A device removed from the account while running signs itself out:

- A packaged or plain dev app ends its Clerk session too and lands on the signed-out account page.
- A profile with a cloned sign-in (`--clone-login` writes a marker beside the token store) drops only the account layer, because its Clerk session belongs to the plain dev app and ending it would sign every window out. If relaunched, such a profile re-enrolls.

Either way, signing out tears down the remote setup:

- The hub socket and the tunnel stop.
- Every direct session closes and port forwards end.
- Every mirror ends: its copy stays as an ordinary worktree, and the thread explains why.
- The shared settings copy is dropped (peers send it back on the next sign-in).
- The login item is cleared (packaged builds only, since a dev run never installs one).
- The window shows no peers (no device tabs and no device filter) until the next sign-in.

The devices that stay end their mirrors with the removed device the next time they read the registry. A relaunch after `--fresh` creates a new device.

## Other tools

- **Web client** (`pnpm web:dev`, port `WEB_PORT`). A third device that connects through the tunnel only, making it the way to test the tunnel data path on one machine. Launch the desktop app with `SM_ACCOUNT_WEB_ORIGIN` set to the web client's origin so the desktop admits it:

  ```sh
  SM_ACCOUNT_WEB_ORIGIN=http://localhost:$(sed -n 's/^WEB_PORT=//p' .env.ports) pnpm dev
  ```

  The dev hub must also list the web client's origin among the app's origins (`http://localhost:*` matches any port). The web client is a hostless controller (the desktop UI with no local projects): anything a desktop can do to a peer (browse its worktrees, run and watch its scripts, change its settings) works from a browser tab the same way, while anything local by nature (launch tools, this device's settings, port forwarding) is absent.

- **Local Colibrii service.** See Colibrii's `service/README.md` ("Local development") for how to run one. It serves on `http://localhost:8787` and knows only the apps added to its local database, so add an app for `sm` there first (using its `app --local` script) with the dev Clerk instance's public key and the dev app's origins. Set `SM_DEVICE_HUB_URL` to that address and `SM_DEVICE_HUB_APP` to the app's id to run against it instead of the dev instance. It creates no tunnels (provisioning a tunnel calls Cloudflare), so devices on it reach each other only over the LAN, and the web client (which dials tunnels alone) cannot reach any device.

- **Packaged build, as a test flavor** (`SM_FLAVOR=<word> pnpm package`, `lab` by convention). Any word not used by another build creates a test flavor, and every name is derived from it (`Shigoto no Mori (lab)`, `com.sylophi.shigomori.lab`, `shigomori-lab://`, `~/.smlab`, and `smlab`, via `derive` in [`packages/engine/src/flavor.ts`](../../packages/engine/src/flavor.ts)). It runs alongside the installed app and the dev app and shares nothing with them ([`packages/engine/src/footprint.ts`](../../packages/engine/src/footprint.ts) lists everything it puts on the machine).

  A test flavor has no updates and no login item. It is never signed with a Developer ID (forge refuses when `APPLE_SIGNING_IDENTITY` is set), so it runs on the mock keychain on macOS, and it accepts a debugging port just like the dev app. It cannot sign in because Clerk's dev instance refuses its scheme's origin (`origin_authorization_headers_conflict`), so a flow that needs an account must run on a dev profile instead. On macOS:

  ```sh
  SM_FLAVOR=lab pnpm package
  node scripts/smoke-app.mts "out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app" --serve 9341
  # weblab: new { "name": "lab", "attach": "127.0.0.1:9341", "dir": "<this checkout>" }
  "out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app/Contents/Resources/smlab" nuke --yes
  ```

  [`scripts/smoke-app.mts`](../scripts/smoke-app.mts) opens the store on two fresh data folders, then with `--serve` leaves the app running on a third fresh folder with the debugging port open until it is stopped, and deletes that folder. `smlab nuke --yes` then removes everything of the build from the machine, including its bundle.

- **Windows installer** (`pnpm package:windows`, with `SM_FLAVOR` set for a test flavor). Produces `Setup.exe` and the update package in `out/make/velopack/`. A test flavor installs into its own folder under `%LOCALAPPDATA%`. Uninstalling it from Apps & features or running `Update.exe uninstall` there removes both the folder and its shortcuts.

- **Packaged prod build** (`pnpm make`). The only way to test a packaged scheme registration under the real names.

  On macOS, building without `APPLE_SIGNING_IDENTITY` in the build environment leaves the bundle unsigned, so like dev it runs on Chromium's mock keychain. The real keychain is exercised only by a Developer-ID-signed build (the release workflow). A local prod build on macOS shares the installed app's `userData`, and tokens it writes are under the mock key, so switching between it and the installed app signs the other out once.

  A prod build takes no debugging port: it quits if started with `--remote-debugging-port` or `--remote-debugging-pipe` ([`main/electron/debugSwitches.ts`](../main/electron/debugSwitches.ts)), and it ignores `--sm-lab`. On macOS, read and drive its window through macOS Accessibility instead by setting `AXManualAccessibility` once the page is up to request its page tree ([`lab/relaunch.mts`](relaunch.mts)), and read `main.log`.

  On macOS, `node scripts/smoke-app.mts <the .app>` launches it on fresh data folders and waits for its store to open, as the release job does. When `APPLE_SIGNING_IDENTITY` is set and the build is signed by it, the smoke script also has the app update itself into a copy re-signed under a newer version, as the release job does too. Its launches write to the build's `userData` and logs folder, and launching a build of a flavor whose app is already running on this machine quits at its single-instance lock.
