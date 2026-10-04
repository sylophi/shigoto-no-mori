# Remote features: what should hold

What each remote feature should do, written as expectations to check
a change against on device windows (`devices.md`). Not a script: pick
the areas a change touches, and test them in whatever order and
through whichever surface (the UI, the bridge, the CLI) fits.

Much of this also has a proof in `../test` that runs without the hub
(`mirror`, `mirror-invites`, `mirror-status`, `sync-transfer`,
`control`, `direct-plane`, `hub-link`, `port-forward`,
`shared-settings`, `liveness`, `clone`). What only device windows show
is all of it together: the real hub, Clerk, two apps and the CLI.

Below, a and b are two devices. Each move lands on one and leaves the
other; most need both devices to hold the same repo (`devices.md`,
"Filling a data dir with test repos"), and the ones about command
access need b's switch off and then on
(`window.api.account.setAcceptsCommands`).

## Presence and reading

- **Presence.** Each device's roster holds the other, and a's registry
  shows b online, then connected.
- **Remote read.** a lists b's projects and the worktrees in them.
- **Command access.** With b's switch off, a's `worktrees:create` on b
  is refused with the typed message. With it on, the worktree is made
  and its path exists on b's disk.
- **Port forward.** a forwards a loopback server on b, and bytes
  round-trip.
- **Clone onto a peer.** a asks b to clone a `git://` remote into a
  folder on b and register it. Refused with b's switch off (the folder
  listing too), and for an option-shaped string or a path as the URL.
  The checkout lands, lists with an identity, and its `cloneUrl` reads
  back (a repo whose origin is a path answers null). A second clone
  onto the same folder is refused.

## Shared settings

- With b's switch off, a value written on a still lands in b's own
  copy, by b's pull alone. With it on, one written on b lands in a's,
  and the two copies read identical.
- **Offline catch-up.** A value written on a while b is off reaches b
  once b's session lands again, with no server having held it.

## Transplants

A transplant is a pull (or a send) and then a finish step that tears
the source down.

- **Pull.** a pulls one of b's worktrees: it lands under a's data dir
  on the same branch, and the project's setup script runs once there.
- **Finish.** The finish step removes the source from b's disk, and
  the copy stays on a. A source edited after its transplant is kept,
  with the reason.
- **Setup off, nothing left out** (the dialogs' default pairing). Setup
  does not run, the uncommitted work is re-applied, and every ignored
  file lands with the source's content, build output included. The
  transfer is one way and leaves no session on either device.
- **Setup on, nothing left out.** The copy keeps the build output its
  own setup made, the clash is counted in the result, the other
  ignored files cross, and the source is not written to.
- **Custom rule.** The picked path stays on b while its ignored
  siblings cross.
- **Gitignored rule.** The review's ignored list names the right
  paths. No files step runs, no ignored file crosses, and an absent
  `runSetup` runs setup. A clean source is removed without force.
- **Bring rule** (gitignored with an exception). The picked ignored
  path crosses, and its ignored siblings stay on b.
- **Failing setup.** A setup script that exits non-zero still leaves a
  real worktree with the uncommitted work applied.
- **Refusals.** A second transplant (or a mirror) of a branch a
  already holds, a taken folder name, and a branch gone from the
  source are all refused, leaving no worktree, no session on b and no
  incoming ref.
- **To a peer** (a send). a sends one of its own worktrees to b with
  a's own switch off: only b has to accept commands. The branch, the
  uncommitted work and the ignored files land on b with no incoming
  ref left there. A second send is refused by b, and the finish step
  removes a's source only once it again matches what was sent.
- **Onto a device with no checkout.** With no clone of the repo on a,
  a dirty worktree of b's comes to a through a clone-first pull: the
  repo is cloned, the branch lands in it with the edits applied, and
  the source is torn down on b.

## Mirrors

A mirror always runs on the device holding the original, so "b's
mirror onto a" is a session on b.

- **Start from the copy's side.** a asks b to mirror a fresh worktree
  of b's onto a (a's `mirror.startFrom`, which runs `mirror:startTo`
  on b with a as the target), with `runSetup: false` and a's command
  access off: setup does not run, and the ask's invitation is what
  b's send, stream and git half land through. The session is b's: b
  lists it (its local side the original, labelled
  `copySide: "remote"`) with its ignore rule and start time, a runs
  none, a's served stream names b's original, and b's history opens
  with `started`.
- **Carrying work.** Files written on either side land on the other, a
  gitignored file included. A commit on b lands on a with the same tip
  and a clean status.
- **Changing what is left out.** New ignores on b re-open the session,
  and a path under the new rule stays on a while its sibling crosses.
- **Stop.** Stopping on b clears b's session and a's served stream,
  and removes a's copy from disk.
- **To a peer.** a mirrors one of its own worktrees to b and runs the
  session itself. Files and a commit made on b's copy come back to a,
  and the stop removes b's copy while a's original stays.
- **Gitignored rule, setup on, pause.** Setup runs on the copy, each
  side keeps its own ignored files, and tracked work crosses. Paused,
  it carries nothing, and resuming carries what was held.
- **Controlled from the copy's side.** a sees b's session against its
  copy, and is refused while b accepts no commands. With b's switch on,
  a pauses it (a file written meanwhile stays put), resumes it (the
  file crosses), and stops it unforced: a's copy goes, b's original
  stays, and a's served stream ends.
- **Diverged stop is refused.** Both sides commit while paused. The
  pair reads diverged with both tips untouched, and Stop is refused
  and changes nothing, asked on b or from a through b. A forced stop on
  b ends the session and removes a's copy with its commit, and b's
  original keeps its own.
- **A primary checkout.** b's primary mirrored onto a: the copy is a
  worktree on `mirror/main` in a `mirror-` folder, commits cross both
  ways, both primaries stay on their own branches, the copy follows
  b's primary onto a new branch and back, and an unforced stop removes
  the copy alone.
- **Onto a device with no checkout.** b holds a repo with no remote
  that a has no checkout of. b's start refuses until told where to
  clone (in a's terms), then clones the repo over the device link into
  that folder, registers it with the same identity, lands the primary's
  copy on `mirror/main` beside it, and runs the session. A commit on b
  reaches the copy, and b's stop removes the copy and leaves the clone
  as an ordinary project.

Two checks no proof covers. With a mirror running, relocate its
original on the device running it: that device's session is gone from
`window.api.mirror.list()`, and the other device's page for the copy
no longer says it is mirrored. And a delete the CLI refuses (dirty
tree, no force) leaves the mirror running.

## The dialogs

The same moves through the real UI: a worktree's row in the sidebar
(inside its project), its page's footer button, the review's rule
picker and setup switch, then Start.

- **Mirror, default switch.** The setup switch is off under Nothing,
  follows Gitignored to on and back, the running view lists setup as
  skipped, and the mirror it starts runs no setup on the copy.
- **Mirror onto a device with no checkout.** The review offers the
  clone, with a folder that follows the source's layout under the
  landing device's home, and "Change folder" to pick another.
- **Transplant, switch pinned off.** Turned off under Gitignored, it
  stays off through rule changes, the running view lists setup as
  skipped, and the transplant runs no setup and brings no ignored
  file.
- **Transplant, switch pinned on.** Turned on under Nothing, setup
  runs, the running view names the setup command, and the copy keeps
  its own build output.
- **Transplant to a peer.** The local page's "Transplant to…" opens on
  the one ready device. The copy lands there with the edits, and "Tear
  it down" removes the source and leaves for the copy's page on the
  peer.
- **Cancelled mid-setup.** With the setup script hung, Cancel reads
  "Cancelling…" and then "Transplant cancelled" (or "Mirror
  cancelled") within moments. The script is dead, the copy is gone
  from disk, list and incoming refs, the source keeps its uncommitted
  edit, and a second cancel finds nothing. For a mirror, the cancel
  goes to the device running it, and no session is left there.

## The CLI

The same verbs from the real `smd`, pointed at a device's data dir
(`devices.md`, "From a terminal").

- `send --source teardown` moves a's worktree to b, `list --remote`
  shows it there, and `bring` brings it back.
- `mirror` copies a worktree to b under a session a runs, answers a
  second ask with the running mirror, and carries a file and a commit
  across.
- Pointed at b, `mirrors` lists that mirror from b's side (copy local,
  a the other device), and `unmirror` is refused while a accepts no
  commands, then removes b's copy only and ends a's session.
- `mirror --from` works with a accepting no commands: b runs it, its
  send and session landing on a through the ask's invitation, commits
  made on either side reach the other while a's switch stays off, and
  a's `unmirror` stops it through b, removing a's copy and keeping b's
  original.

## Leaving the account

- **A device going away.** Killed outright, b drops from a's roster.
  Relaunched, both reconnect.
- **Revoke.** a removes b from the account after starting a mirror
  each way. a's roster and registry drop b, and b signs itself out:
  its hub socket stops, its direct sessions close, the port forward it
  ran is gone, its mirror onto a ends (the copy on a kept), its shared
  settings are dropped, and no device tabs remain. a ends its mirror
  onto b too, once its registry no longer lists b, the copy on b kept.
