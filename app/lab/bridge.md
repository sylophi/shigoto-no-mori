# The bridge

What a `js` step can ask a device window, and the same verbs from a
terminal. The page's api (`renderer/lib/runtime/pageApi.tsx`) is built
over the window's real links, to its shell and to its host. A call is an
effect, and the api runs it on the window's runtime: `api.run(call)` is
the call's answer as a Promise, which a `js` step awaits. The calls below
are written bare; run each the same way.

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

| Call                                                                | Returns                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.deviceId`                                                      | This window's device id.                                                                                                                                                                                                                                                                             |
| `api.account.status()`                                              | `signedIn`, `accountId`, `deviceName`, `configured`.                                                                                                                                                                                                                                                 |
| `api.account.listDevices()`                                         | The account's device registry from the hub, with `online`.                                                                                                                                                                                                                                           |
| `api.account.setAcceptsCommands(bool)`                              | Flips this device's command-access switch.                                                                                                                                                                                                                                                           |
| `api.sharing.set(bool)`                                             | Flips this device's sharing switch.                                                                                                                                                                                                                                                                  |
| `api.account.signOut()`                                             | Revokes this device and clears the credential. Clerk is untouched.                                                                                                                                                                                                                                   |
| `api.hub.status()`                                                  | Socket phase, `onlineDeviceIds`, `peerAppVersions` (one key per direct session), `peerAcceptsCommands` (whether each runs this device's commands), `peerSharesData` (whether each shares with it at all), `tunnel`.                                                                                                                                         |
| `api.hub.invokePeer({deviceId, channel, input})`                    | Any host call on a peer, e.g. `projects:list`, `worktrees:list`, `worktrees:create`.                                                                                                                                                                                                                 |
| `api.peerApi(deviceId)`                                             | A peer's api over the same hop: its host modules, e.g. `peer.run(peer.projects.list())`, and its pushes and views (`peer.view(terminalsContract, "attach", input)`). It has no client modules.                                                                                                     |
| `api.sync.pullWorktree({...})`                                      | Brings a peer's worktree here. The payload is the contract's, in `packages/contracts/src/modules/sync.ts`. With `ignoreMode` and `ignores` (the mirror's leave-out rule) it also brings the ignored files the rule admits, through the mirror engine run once and one way, source to here (the `files` step, reported as `files` on the result). `gitignored` has nothing to bring and skips it. |
| `api.sync.sendWorktree({targetDeviceId, projectId, worktreeId, ...})` | The pull turned around: sends one of this device's worktrees to a peer (the local page's "Transplant to"). The peer runs the pull's own landing, asking back over a link this device opens, and its progress (the create's phases included) comes back here. Takes the pull's `runSetup`, `ignoreMode`, `ignores` and `cloneInto`, and returns the pull's result, with `worktree` the copy on the peer. Only the peer has to accept commands. |
| `api.sync.cancelMove({sourceWorktreeId})`                           | Cancels a move in flight, by the source worktree its progress is keyed under: a `pullWorktree` or `sendWorktree` this device runs, or a `mirror.startTo` (asked of the device running it, the peer for "Mirror here"). The move fails with `The move was cancelled`, whatever it was waiting on: the create's CLI child (and the setup script it runs) is killed, the worktree it made is removed with `sm rm --force` (its cleanup on a one-minute clock), a link is reset, a files-step session ended, and a mirror's session terminated if the open outran the cancel. A repo the move cloned first stays as a project. Nothing on the source changes, and no receipt is kept, so no teardown follows. `cancelled: false` means nothing by that key was in flight (the move is over). A caller that goes away (the window reloads, a peer's or the CLI's socket dies) cancels the same way. The dialogs' running step has the Cancel button. Escape and the backdrop still don't close it. |
| `api.sync.teardownSource({direction, deviceId, projectId, worktreeId})` | Second half of a transplant, either way: removes the source while it is still what moved. `deviceId` is the peer the move came from (`pull`) or went to (`send`), and `projectId`/`worktreeId` name the source worktree (the peer's after a pull, this device's after a send). |
| `api.sync.ignoredPaths({projectId, worktreeId})`                    | The ignored files on a worktree (`paths`, full `total`) and the gitignore rules behind them (`patterns`). Grant-gated. The transplant dialog lists them, the mirror dialog chooses from them.                                                                                                        |
| `api.sync.worktreeFolder({projectId, worktreeId, relative, ruleIgnored})` | One folder of a worktree with git's ignore verdict per entry. Grant-gated. The mirror dialog's picker browses it.                                                                                                                                                                                    |
| `api.worktrees.readFile({projectId, worktreeId, path})` | One file of a worktree for the files page: `{kind: "text", contents, size}`, or `binary` / `tooLarge` (over 1 MiB) with the size, or `missing`. Grant-gated like `worktreeFolder`, which the page browses with. |
| `api.projects.carryOverListing({...})` | One folder of a project (`projectId`, `relative`), unioned across its checkouts on that device. Not grant-gated. The carry-over picker browses it, and with `ruleIgnored: true` the Configure page's leave-out picker does, on every device holding the repo. |
| `api.portForward.start({deviceId, remotePort})`                     | Forwards a peer's loopback port. Returns `localPort`.                                                                                                                                                                                                                                                |
| `api.mirror.startTo({targetDeviceId, projectId, worktreeId, ...})` | Copies one of this device's worktrees to a peer and keeps the two mirrored (files both ways, git state followed). The `sync.sendWorktree` payload plus `ignoreMode` (`everything`, `gitignored`, `custom`, `bring`) and `ignores` (engine patterns, `/path` anchors to the root). `bring` is gitignored with exceptions: the gitignore rules, a marker pattern, then a `!/path`, `!/path/**` pair per ignored path that crosses anyway, its glob syntax escaped (`bringIgnores` in `packages/contracts/src/mirrorIgnores.ts`). `runSetup: false` skips the setup script at the copy's create (the dialogs default it off when nothing is left out, and on once the rule leaves something behind). A mirror always runs on the device holding the original, labelled `copySide: "remote"`, so `mirror.stop` removes the peer's copy and keeps the original. The local page's Mirror button calls it here. A peer's page (its Mirror button) runs `api.mirror.startFrom({sourceDeviceId, sourceProjectId, sourceWorktreeId, runSetup?, ignoreMode, ignores, cloneInto?})` here instead (what the peer's `startTo` takes, in the pull's terms, plus the rule): it asks the peer's `mirror:startTo` with this device as `targetDeviceId`, and relays the peer's progress. The peer must accept commands (it is asked), and so must this device, which must share too: the peer's landing, the copy's stream, git state, commit fetch and push, and delete all reach it through its own switches, so a switch that is off refuses the ask up front. Returns the copy and the `session`. |
| A device with no checkout of the repo                               | Every move takes `cloneInto: {parentDir, name}`, a place on the landing device: `sync.pullWorktree` for this device, `sync.sendWorktree` and `mirror.startTo` for the peer (this device, when a peer runs `mirror.startTo` towards it). With no project of the source's identity there, the source's default branch crosses as a bundle on the move's own link (no remote needed, the grant that gates the move is the gate), is checked out at `parentDir/name` (the parent is made when missing), given the source's remote as `origin` when it has one, registered the way `projects.clone` registers (`sm projects add`, config seed included), and the copy lands in it as usual. A copy that would land on the clone's own default branch is refused before anything is made. Reported as the `clone` step (with bytes) and as `cloned` (the new project) on the result. A project that matches wins over `cloneInto`: nothing is cloned. A checkout of the same repo (by identity) already at `parentDir/name` is registered as it is, its files untouched, and the copy lands in it, still reported as `cloned`. `sync.cloneDestination({cloneInto, identity})` answers what is at that folder before a move starts: `free`, `taken` or `same-repo`, which the dialogs show beside Change (a taken folder holds Start). Without `cloneInto` the move refuses. The dialogs offer it (Mirror and Transplant on a peer's worktree when this device holds no checkout, and on a local worktree onto a peer that holds none), defaulting the folder to the source's own layout with its home swapped for the destination's. The CLI's `send` and `mirror --to` take such a device too, cloning into the same default (or `--clone-into <dir>`, a folder on it). `bring` and `mirror --from` still need a device that holds the repo. |
| Mirroring a primary checkout                                        | The start takes a primary, from either page. Its copy is an ordinary worktree on `mirror/<branch>` in a `mirror-<name>` folder (the landing device's own primary holds `<branch>` and is usually called `<name>`), and the git follower reads the pair as one branch: a commit on the source's `main` lands on the copy's `mirror/main` and back. The session carries a `mirrorBranch: "1"` label, which is all the follower needs: the rule holds for every branch the primary moves to. Both primaries stay untouched, and stop removes the copy as usual. The CLI's `mirror --from` and `mirror --to` take a primary the same way. `bring` and `send` refuse one. |
| `api.mirror.list()`                                                 | This device's mirror sessions (`status`, `git.status`, conflicts, `ignoreMode`, `ignores`, `createdAt`) and the streams it serves for peers (`peerWorktreeId` names the peer's copy).                                                                                                                |
| `api.mirror.stop({session, force?})` / `pause({session})` / `resume({session})` | Controls a session this device runs. Stop also removes the copy, on the peer (a forced delete, and the original keeps its own), so the copy's page moves on. Unforced, it is refused unless the copy holds nothing the original lacks (git in step, looked at again at the stop, and the files settled: no conflict held still, both sides connected, nothing staging), with the reason after `MIRROR_STOP_UNCONFIRMED`. A stop whose original is gone (removed outside the app) ends the session and keeps the copy, forced or not. A copy the peer no longer lists (deleted from a terminal, or while this device was away) ends the session without the synced check, and with nothing to remove. A copy deleted in the app ends its session here on its own, through the peer's `worktrees:removal` announcement. Served to peers on this device's command grant: the far end's page drives the session through the device running it (`hub.invokePeer` to it, in the console), so either side controls the mirror.                              |
| `api.mirror.setIgnores({session, ignoreMode, ignores})`             | Changes what a running mirror leaves out. Re-opens the session and returns the new id. Served to peers like the controls above.                                                                                                                                                                         |
| `api.mirror.history({localWorktreeId})`                             | The mirror's thread of events, kept by the device that runs it and keyed by its local worktree, the original.                                                                                                                                                                                                      |


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
