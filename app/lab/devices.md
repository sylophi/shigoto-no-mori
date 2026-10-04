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
(`scripts/dev-device.mts`) runs a dev window as a dev profile
(`dev-app.md`) with its debugging port on `PORT` (or
`SHIGOMORI_DEBUG_PORT`). The first window of a worktree is the
primary, a full `pnpm dev`: the build, the renderer's vite server,
deep links. A window started while that server answers is a peer on
the primary's build, so open the primary first, and end the peers
before it, or everything at once.

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

Two ways in, and most checks use both: as a person (a `look`, then
clicks by role and name, the way the UI reads) and through the bridge
(a `js` step on `window.api`, which awaits what a call returns). Drive
the UI when the UI is what changed. Check outcomes where they land:
the bridge's answers, the other device's window, and the disk.

## What you can exercise

- **Two devices, or more.** Each `new` with its own profile and port
  is another device on the account: a third window is `<tag>-c`. The
  web client is one more, through the tunnel only (`dev-app.md`,
  "Other tools").
- **A repo both hold.** Moves need the same repo on both devices
  (`dev-app.md`, "Filling a data dir with test repos"). With no
  checkout on the landing device, a move clones it first, which is
  worth checking too.
- **Moves, mirrors and their dialogs.** Start them from the UI (a
  worktree page's footer: Transplant, Mirror) or through
  `window.api.sync` and `window.api.mirror`, then watch both windows
  and the disk. What each should do is in its contract
  (`shared/ipc/modules/`) and in `bridge.md`. Two mirror cases
  no proof covers: relocate a mirrored original on the device running
  it (its session leaves `window.api.mirror.list()`, and the other
  device's page for the copy stops saying it is mirrored), and a
  delete the CLI refuses (dirty tree, no force) leaves the mirror
  running.
- **Command access.** `window.api.account.setAcceptsCommands(false)`
  on one device, to see the other's asks refused and what the UI says.
- **The CLI between them.** `smd` pointed at a profile's data dir runs
  the cross-device verbs against its running app (`bridge.md`, "From
  a terminal").
- **A device going away.** `end` stops a window cleanly. To kill one
  mid-socket, the way a crash would, kill its process tree (match its
  profile's userData path, for example
  `pkill -9 -f "profiles/<tag>-b"`), then `end` its session and open
  it again with the same `new` (without `--fresh`): it boots as the
  same device. Presence, reconnects and offline catch-up show there.
- **The tunnel path.** On one machine the LAN wins; launch a device
  with `SHIGOMORI_DIAL_KINDS=tunnel` in its `start` to take the
  tunnel instead (`dev-app.md`, "Rules").
- **A record of it.** Open each window's session with `"video": true`
  before the flow starts, so the videos line up. `screen` shots also
  catch native menus, given Screen Recording permission.

## Cleaning up

Every profile enrolls a device on the dev hub. Ending a window,
`--fresh` and deleting folders are local: the device and its tunnel
stay on the account until revoked. So revoke first, then end.

A window launched with `--fresh --clone-login` in this run can revoke
the others and then itself. Not one that booted with its credential
on disk (a relaunch): it holds a live Clerk session and no enrollment
attempt armed, so ClerkAccountSync re-enrolls it the moment the
credential clears. Revoke such a window from another device, and
never with its **Sign out** button in a cloned window (`dev-app.md`,
"Rules").

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

What a removed device does to itself and to the devices that stay is
in `dev-app.md`, "When a device is removed".

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
  Nothing local revokes it. Revoke it from another device ("Cleaning
  up").
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
