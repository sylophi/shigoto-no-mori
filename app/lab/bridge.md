# The bridge

Device windows expose a page API for `js` steps, and the CLI exposes the same operations from a terminal. The page API ([`renderer/lib/runtime/pageApi.tsx`](../renderer/lib/runtime/pageApi.tsx)) sits directly on top of the window's real links to its shell and host. Each call returns an Effect that the API runs on the window's runtime: `api.run(call)` executes the call and returns its result as a Promise, which a `js` step awaits. The calls in the table below are written bare. Pass each one to `api.run(...)` the same way.

Normally the app stores this API in a React context rather than on `window`. When running a dev build, the fake host, or a test flavor launched with `--sm-lab`, [`renderer/lib/runtime/labHandle.ts`](../renderer/lib/runtime/labHandle.ts) exposes it to external tools as `window.__smLab.api` (abbreviated as `api` below). Reaching it requires a debugging port, which a packaged prod build refuses ([`dev-app.md`](dev-app.md), "Packaged prod build"):

```json
{ "js": "((api) => api.run(api.hub.status()))(window.__smLab.api)" }
```

Lab scripts access `window.__smLab.api` through [`reliability/pageApi.mts`](reliability/pageApi.mts).

## Useful bridge calls

| Call | Returns |
| --- | --- |
| `api.deviceId` | This window's device ID. |
| `api.account.status()` | `signedIn`, `accountId`, `deviceName`, `configured`. |
| `api.account.listDevices()` | The account's device registry from the hub, including each device's `online` status. |
| `api.account.setAcceptsCommands(bool)` | Sets this device's command-access switch. |
| `api.sharing.set(bool)` | Sets this device's sharing switch. |
| `api.account.signOut()` | Revokes this device and clears its local credential. Clerk is untouched. |
| `api.hub.status()` | Socket phase, `onlineDeviceIds`, `tunnel`, and per-direct-session `peerAppVersions`, `peerAcceptsCommands`, `peerSharesData`. For a peer on another release, also includes `peerOutdated` (the modules this device cannot call on that peer) and `peerCoreOutdated` for peers too far apart to link with. |
| `api.hub.invokePeer({deviceId, channel, input})` | Calls any host channel on a peer, e.g. `worktrees:list`. |
| `api.peerApi(deviceId)` | Returns a peer's API over the same hop: its host modules, pushes, and views, without client modules. |
| `api.sync.pullWorktree({...})` | Copies a peer's worktree onto this device. The result's `worktree` is the new copy. |
| `api.sync.sendWorktree({targetDeviceId, projectId, worktreeId, ...})` | The reverse of a pull ("Transplant to"): sends a local worktree to a peer. The result's `worktree` is the copy on the peer. |
| `api.sync.cancelMove({sourceWorktreeId})` | Cancels an in-flight pull, send, or mirror start by its source worktree. Returns `cancelled: false` when none was in flight. |
| `api.sync.teardownSource({direction, deviceId, projectId, worktreeId})` | Runs the second half of a transplant: removes the source worktree while it still matches what was moved. |
| `api.sync.ignoredPaths({projectId, worktreeId})` | Returns a worktree's ignored files (`paths`, `total`) and the ignore rules behind them (`patterns`). |
| `api.sync.worktreeFolder({projectId, worktreeId, relative, ruleIgnored})` | Lists one folder of a worktree, with git's ignore verdict for each entry. |
| `api.worktrees.readFile({projectId, worktreeId, path})` | Reads one file and returns `text` with its contents, or `binary`, `media`, `tooLarge`, or `missing`. |
| `api.projects.carryOverListing({...})` | Lists one folder of a project across all of its checkouts on that device. |
| `api.portForward.start({deviceId, remotePort})` | Forwards a peer's loopback port to this machine and returns `localPort`. |
| `api.mirror.startTo({targetDeviceId, projectId, worktreeId, ...})` | Copies a worktree to a peer and keeps both copies mirrored. Returns the copy and its `session` (`startFrom` asks a peer to mirror toward this device instead). |
| `api.mirror.list()` | Lists this device's mirror sessions and the streams it serves for peers. |
| `api.mirror.stop({session, force?})` / `pause({session})` / `resume({session})` | Controls a mirror session this device runs. Stop removes the peer's copy (unless the original is already gone); without `force`, it is refused unless the copy contains nothing the original lacks. |
| `api.mirror.setIgnores({session, ignoreMode, ignores})` | Updates what a running mirror excludes and returns the new `session`. |
| `api.mirror.history({localWorktreeId})` | Returns the mirror's event history, stored by the device that runs it. |

## Arguments

`api.<module>.<call>` and `hub.invokePeer` both accept the call's contract payload from `packages/contracts/src/modules/<module>.ts`, such as `portForward.stop({forwardId})` and `ports.list({projectId, worktreeId})`. A push is a stream identified by its module contract and event name. `api.listen` subscribes to it and returns a stop function that ends the subscription: `api.listen(api.pushes(mirrorContract, "changed"), handler)`.

If a call rejects with an error naming a missing or unexpected key, the payload does not match the call's contract schema.

## From a terminal

The CLI exposes the same operations by forwarding requests to the running app over the loopback socket ([`host/socket/Loopback.ts`](../host/socket/Loopback.ts)). From a checkout of the repo, point `smd` at the data directory of the profile whose app should act:

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

If no app is running or reachable at the selected `SHIGOMORI_DATA_DIR`, the commands above fail with `app-not-running`.

## DOM hooks

Use the DOM only where a user would click. To reach the account page (the device registry), open Settings using the sidebar's Settings button (`aria-label="Settings"`) and select the Account row in Settings' sidebar list, or navigate directly to `/account`. Clerk's modal renders as plain DOM in the page with `.cl-*` classes.
