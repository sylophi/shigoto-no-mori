# The bridge

What a `js` step can ask a device window, and the same verbs from a
terminal. The page's api (`renderer/lib/runtime/pageApi.tsx`) is built
over the window's real links, to its shell and to its host. A call is an
effect, and the api runs it on the window's runtime: `api.run(call)` is
the call's answer as a Promise, which a `js` step awaits. The calls below
are written bare. Run each the same way.

The app keeps it in a React context, not on `window`. A dev build, the
fake host and a test flavor started with `--sm-lab` hand it to tools
outside the page as `window.__smLab.api`
(`renderer/lib/runtime/labHandle.ts`), which `api` below stands for.
Reaching it takes a debugging port, which a packaged prod build
refuses (`dev-app.md`, "Packaged prod build"):

```json
{ "js": "((api) => api.run(api.hub.status()))(window.__smLab.api)" }
```

The lab's scripts read it through `reliability/pageApi.mts`.

## Useful bridge calls

| Call | Returns |
| --- | --- |
| `api.deviceId` | This window's device id. |
| `api.account.status()` | `signedIn`, `accountId`, `deviceName`, `configured`. |
| `api.account.listDevices()` | The account's device registry from the hub, with `online`. |
| `api.account.setAcceptsCommands(bool)` | Flips this device's command-access switch. |
| `api.sharing.set(bool)` | Flips this device's sharing switch. |
| `api.account.signOut()` | Revokes this device and clears the credential. Clerk is untouched. |
| `api.hub.status()` | Socket phase, `onlineDeviceIds`, `tunnel`, and per direct session `peerAppVersions`, `peerAcceptsCommands` and `peerSharesData`. |
| `api.hub.invokePeer({deviceId, channel, input})` | Any host call on a peer, e.g. `worktrees:list`. |
| `api.peerApi(deviceId)` | A peer's api over the same hop: its host modules, pushes and views, and no client modules. |
| `api.sync.pullWorktree({...})` | Brings a peer's worktree here. The result's `worktree` is the copy. |
| `api.sync.sendWorktree({targetDeviceId, projectId, worktreeId, ...})` | The pull turned around ("Transplant to"). The result's `worktree` is the copy on the peer. |
| `api.sync.cancelMove({sourceWorktreeId})` | Cancels a pull, send or mirror start in flight, by its source worktree, with `cancelled: false` when none was. |
| `api.sync.teardownSource({direction, deviceId, projectId, worktreeId})` | A transplant's second half: removes the source while it is still what moved. |
| `api.sync.ignoredPaths({projectId, worktreeId})` | A worktree's ignored files (`paths`, `total`) and the rules behind them (`patterns`). |
| `api.sync.worktreeFolder({projectId, worktreeId, relative, ruleIgnored})` | One folder of a worktree, with git's ignore verdict per entry. |
| `api.worktrees.readFile({projectId, worktreeId, path})` | One file: `text` with its contents, or `binary`, `media`, `tooLarge` or `missing`. |
| `api.projects.carryOverListing({...})` | One folder of a project, across its checkouts on that device. |
| `api.portForward.start({deviceId, remotePort})` | Forwards a peer's loopback port and returns `localPort`. |
| `api.mirror.startTo({targetDeviceId, projectId, worktreeId, ...})` | Copies a worktree to a peer and keeps the two mirrored. Returns the copy and its `session` (`startFrom` asks a peer to mirror towards here). |
| `api.mirror.list()` | This device's mirror sessions, and the streams it serves for peers. |
| `api.mirror.stop({session, force?})` / `pause({session})` / `resume({session})` | Controls a session this device runs. Stop removes the peer's copy (not when the original is gone), and unforced it is refused unless the copy holds nothing the original lacks. |
| `api.mirror.setIgnores({session, ignoreMode, ignores})` | Changes what a running mirror leaves out and returns the new `session`. |
| `api.mirror.history({localWorktreeId})` | The mirror's events, kept by the device that runs it. |


## Arguments

`api.<module>.<call>` and `hub.invokePeer` both take the call's
contract payload, from `packages/contracts/src/modules/<module>.ts`,
e.g. `portForward.stop({forwardId})` and
`ports.list({projectId, worktreeId})`. A push is a stream, by its
module and name, and `api.listen` reads it until the stop it returns:
`api.listen(api.pushes(mirrorContract, "changed"), handler)`.

A rejection naming a missing or unexpected key means the payload does not
match the call's contract schema.


## From a terminal

The same verbs are on the CLI, which asks the running app for them
(over the loopback, `host/socket/Loopback.ts`). Point `smd` at the profile whose app
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
fails with `app-not-running`.


## DOM hooks

Use the DOM only where a person would click. The account page (the
device registry) is the Account row of Settings' sidebar list (the
sidebar's Settings button has `aria-label="Settings"`), or just
navigate to `/account`. Clerk's
modal is plain DOM in the page, with `.cl-*` classes.
