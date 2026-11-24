# Device windows

Run the real app with as many devices as a test needs, each as a dev window that weblab starts and attaches to:

```json
{ "name": "a", "attach": "127.0.0.1:9241", "address": "127.0.0.1:9241", "start": "SHIGOMORI_DEBUG_PORT=9241 pnpm device <tag>-a --fresh --clone-login", "startTimeout": 240000, "tab": "shigomori-dev://" }
```

```json
{ "name": "b", "attach": "127.0.0.1:9242", "address": "127.0.0.1:9242", "start": "SHIGOMORI_DEBUG_PORT=9242 pnpm device <tag>-b --fresh --clone-login", "startTimeout": 240000, "tab": "shigomori-dev://" }
```

`attach` drives the window over Chromium's debugging port. `address` and `start` make weblab launch the window: because nothing is listening on the port yet, weblab runs `start`, waits for the port, attaches to it, and stops the window when the session ends. weblab runs `start` as written without supplying a `PORT` variable of its own, so the port number must appear in all three places (`attach`, `address`, and `start`).

On Windows, weblab runs `start` through `cmd`, which sets environment variables with `set`. End the value right at `&&` with no space before it, because `cmd` includes any space before `&&` in the variable's value: `"start": "set SHIGOMORI_DEBUG_PORT=9241&& pnpm device <tag>-a --fresh --clone-login"`. Calling `end` stops the window's entire process tree on Windows too.

`pnpm device <profile> [--fresh] [--clone-login]` ([`scripts/dev-device.mts`](../scripts/dev-device.mts)) runs a dev window as a dev profile (see [`dev-app.md`](dev-app.md)) with its debugging port on `SHIGOMORI_DEBUG_PORT`. The first window of a worktree is the primary, which runs a full `pnpm dev` (handling the build, the renderer's Vite server, and deep links). Any window started while that server is listening runs as a peer on the primary's build, so open the primary first, and end the peers before ending the primary (or end everything at once).

On a Linux machine with no display, put `xvfb-run -a` (from the `xvfb` package) in front of `pnpm device` in `start` to give each window its own virtual display. Because no one can reach GitHub's sign-in page on that display, sign the plain dev app in once with a code: launch it with `SHIGOMORI_CODE_SIGN_IN=1 SHIGOMORI_DEBUG_PORT=<port> xvfb-run -a pnpm dev` and attach to it the same way. Sign in shows a link and a code, which `pnpm sign-in <link>` approves (see [`sign-in.mts`](sign-in.mts)). From then on, `--clone-login` copies that sign-in.

Each window's account page should list the other device as online, then connected. The device names end in `[<tag>-a]` and `[<tag>-b]`. Once connected, drive them:

```json
{ "session": "a", "steps": [
  { "expect": { "js": "((api) => api.run(api.account.status()).then((s) => s.signedIn))(window.__smLab.api)" }, "timeout": 60000 },
  { "js": "((api) => api.run(api.hub.status()))(window.__smLab.api)" },
  { "js": "window.__smLab.api.deviceId", "on": "b" },
  { "shot": "b-devices", "on": "b" }
] }
```

There are two ways to drive a window, and most checks use both: as a person (running `look`, then clicking by role and name, the way the UI reads) and through the bridge (a `js` step on the page's API, see [`bridge.md`](bridge.md), which awaits what `api.run(call)` returns). Drive the UI when the UI is what changed. Check outcomes where they land: the bridge's return values, the other device's window, and on disk.

## What you can exercise

- **Two devices, or more.** Each `new` session with its own profile and port is another device on the account (for example, a third window using `<tag>-c`). The web client is one more, connecting through the tunnel only (see [`dev-app.md`](dev-app.md), "Other tools").
- **A shared repository.** Moves require the same repo on both devices (see [`dev-app.md`](dev-app.md), "Filling a data dir with test repos"). If the destination device has no local checkout, a move clones it first, which is worth checking too.
- **Moves, mirrors, and their dialogs.** Start them from the UI (in a worktree page's footer: Mirror, and Transplant under Options) or through the API (`sync` and `mirror`), then inspect both windows and the disk. Each operation's expected behavior is in its contract ([`packages/contracts/src/modules/`](../../packages/contracts/src/modules)), and [`bridge.md`](bridge.md) documents what each call returns. Two mirror cases are worth checking. Relocating a mirrored original on the device running it removes its session from `api.run(api.mirror.list())` and stops the other device's page for the copy from saying it is mirrored. A delete that the CLI refuses (dirty tree, no force) leaves the mirror running.
- **Command access.** A newly enrolled device accepts no commands by default, so moves onto it are refused (the dialogs show it as read-only) and its own "Mirror here" stays off until its switch is turned on (via "Allow control" on its account page, or `api.run(api.account.setAcceptsCommands(true))`). Turn it off on one device to see requests from the other device refused and inspect what the UI shows. While the switch is off, a mirror into that device stops writing and shows as paused, naming the switch. It resumes once the switch is back on.
- **Sharing.** Turn "Share with other devices" off on one device's account page (or call `api.run(api.sharing.set(false))`). The other device then shows it as not sharing, with none of its projects, and any mirror into it pauses the same way.
- **The CLI between them.** Pointing `smd` at a profile's data dir runs the cross-device verbs against its running app (see [`bridge.md`](bridge.md), "From a terminal").
- **A device going away.** Calling `end` stops a window cleanly. To kill one mid-socket like a crash, terminate its process tree by matching its profile's `userData` path (for example, `pkill -9 -f "profiles/<tag>-b"`), then call `end` on its session and open it again with the same `new` (without `--fresh`): it boots as the same device. Presence, reconnects, and offline catch-up can be tested this way. On Windows, the window's main process does not name the profile, so end the process tree under its launcher instead, in PowerShell: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -match 'dev-device.mts <tag>-b( |$)' | % { taskkill /T /F /PID $_.ProcessId }`.
- **The tunnel path.** On one machine, LAN wins between two desktops. Launch a device with `SHIGOMORI_DIAL_KINDS=tunnel` in its `start` command to use the tunnel instead. A web client dials only tunnels (see [`dev-app.md`](dev-app.md), "Rules").
- **Recording a flow.** Run `{ "video": "start" }` on each window's session before the flow starts so the videos line up, and `{ "video": "stop" }` afterward (which returns the file path). `screen` shots also capture native menus if Screen Recording permission is granted.

## Cleaning up

Every profile enrolls a device on the dev hub. Ending a window, passing `--fresh`, and deleting folders are local-only actions: the device and its tunnel stay on the account until revoked. Revoke first, then end the sessions.

Any window can revoke the other devices and then itself: a window that has seen its device enrolled does not enroll it again while its Clerk session lives. Never use the **Sign out** button in a cloned window (see [`dev-app.md`](dev-app.md), "Rules").

```json
{ "session": "a", "steps": [
  { "js": "((api) => api.run(api.account.listDevices()).then((ds) => Promise.all(ds.filter((d) => / \\[<tag>-[a-z0-9-]+\\]$/.test(d.name) && d.deviceId !== api.deviceId).map((d) => api.run(api.account.revokeDevice(d.deviceId)).then(() => d.name)))))(window.__smLab.api)" },
  { "js": "((api) => api.run(api.account.signOut()))(window.__smLab.api)" }
] }
```

Match only your own tag, not every `[...]`, because other tags may belong to another session's live devices. Then call `end` and delete the local profile folders, or launch with `--fresh` next time:

```sh
for p in <tag>-a <tag>-b; do rm -rf ~/.smd-profiles/$p "$HOME/Library/Application Support/Shigoto no Mori (dev)/profiles/$p"; done
```

On Windows, the `userData` folder is under `%APPDATA%`, in PowerShell:

```powershell
foreach ($p in '<tag>-a', '<tag>-b') { Remove-Item -Recurse -Force "$HOME\.smd-profiles\$p", "$env:APPDATA\Shigoto no Mori (dev)\profiles\$p" }
```

See [`dev-app.md`](dev-app.md), "When a device is removed", for what a removed device does to itself and to the remaining devices.

## Troubleshooting

- **Blank window, with `net::ERR_NETWORK_CHANGED` repeating in the log.** The renderer proxy lost the Vite dev server while the network changed. Relaunch.
- **Second `pnpm dev` fails.** From the same worktree, it fails on the renderer port. From another worktree, it exits at the single-instance lock unless it runs as a profile.
- **Profile boots signed out after `--clone-login`.** The plain dev app's Clerk session may have expired even while it still appears signed in: its device credential outlives the Clerk session, and a clone copies the empty session. Open the plain dev app in a weblab session on a free port named in all three places (`"start": "SHIGOMORI_DEBUG_PORT=9341 pnpm dev"`, with `attach` and `address` set to `127.0.0.1:9341`). Check `{ "js": "Boolean(window.Clerk.session)" }`. If it is `false`, run `{ "js": "window.Clerk.openSignIn()" }` and click Continue with GitHub in its window. This signs in again without leaving the account. Then relaunch the profile. Otherwise, sign in from the profile's window.
- **A device from an old profile still shows on the account page.** Nothing local revokes it. Revoke it from another device (see "Cleaning up").
- **`smd` in a new terminal acts on the plain dev data dir.** To target a profile from the shell, set its data dir first: `SHIGOMORI_DATA_DIR=~/.smd-profiles/<name>/data smd ...`.
- **Dev tokens on macOS.** They sit under Chromium's mock keychain, obfuscated but not protected. This is what makes `--clone-login` possible and is fine on the owner's machine.
- **A packaged build asks for the login keychain password.** The "Shigoto no Mori Safe Storage" item in the login keychain was created by a binary with a different code signature, so macOS gates every read behind a dialog. A signed build replaces the item once on its first launch ([`main/core/keychain/reset.ts`](../main/core/keychain/reset.ts)), logs `[keychain]`, and writes `safe-storage.owned` to its `userData` so it never does again. If the dialogs persist (for example, a bundle whose signing failed was opened from `app/out` after the package step stopped on it, and wrote that marker before creating its item), delete the item by hand (`security delete-generic-password -s "Shigoto no Mori Safe Storage"`), remove `safe-storage.owned`, and relaunch. Either way, the next launch starts signed out once.
