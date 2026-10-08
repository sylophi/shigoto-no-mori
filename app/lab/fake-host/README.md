# The fake host

The real UI in a browser over a fake `window.api`: four devices with
mixed presence, shared and remote-only projects (two of them
terrier-sourced), pull requests in every CI state, villagers. So
every multi-device screen can be posed and captured without a device
hub, a second machine, or Clerk. Dev-only: nothing here ships.

Two flavors, each a vite server on this worktree's port from
`.env.ports` (5191 and 5192 without port-pool):

- **Desktop shell**: `pnpm fake-host` on `FAKE_HOST_PORT`. Mounts the
  desktop renderer (`renderer/App.tsx`), the page posing as "Studio
  Mac" over a local forest.
- **Web shell**: `pnpm fake-host:web` on `FAKE_HOST_WEB_PORT`. Mounts
  the real web boot (`web/boot`). The page poses as an enrolled browser
  device, and every machine forest (Studio Mac included) is a peer.
  Under 768px wide it renders the phone layout.

Some ways to use it:

- **One screen, every state.** Walk a pose through its values (each
  `?checks=` variant, presence per peer, `?crowd=` sizes) and shoot
  each. A code file loops over a list as easily as steps.
- **Side by side.** A session per theme, per viewport, or per shell
  (desktop and web) on the same pose, and `on` to shoot them in one
  run.
- **Before and after.** Shoot a screen, make the change (vite reloads
  the page), and hold a new shot to the first with `matches`. Or run
  the fake host of another checkout on its own port beside this one.
- **A flow, step by step.** Open a dialog, click through it the way a
  person would, `expect` each stage, and film the session for a
  reviewer. The sync verbs move the fake world, so the outcome shows.
- **Mid-session changes.** `window.fakeHost` flips a peer's presence,
  drops the socket, or makes a worktree appear behind the app's back,
  to see how a screen already open reacts.

What it cannot tell you: anything below the bridge. Transfers,
mirrors and the hub are posed, and a channel the fixtures don't
handle answers with a stub derived from its schema, so a screen that
renders here proves nothing about the host behind it. Electron itself
(native menus, deep links, the keychain, windows) is absent too. For
those, use device windows (`../devices.md`).

Open one with weblab's `new`, the worktree's port as the address.
`grep FAKE_HOST_ .env.ports` prints both ports. Below, 4752 and 4753
stand for them:

```json
{ "name": "ui", "address": 4752, "start": "pnpm fake-host", "path": "/?theme=dark&to=/account", "viewport": "920x720" }
```

```json
{ "name": "phone", "address": 4753, "start": "pnpm fake-host:web", "path": "/account?theme=light", "viewport": "390x844@3" }
```

Then pose and capture with `run` (`../weblab.md` lists what it can
do). The app scrolls inside its own panes, so a `fullPage` shot shows
no more of a long page: make the viewport taller instead.

```json
{ "session": "ui", "steps": [
  { "goto": "/?theme=light&checks=failing&to=/devices/dev_8f3ac2e1/projects/p_sm/worktrees/wt_sm_hum" },
  { "expect": "happy-hummingbird" },
  { "shot": "checks-failing" }
] }
```

The desktop shell takes the app window's default size, 920x720, not
weblab's 1440x900. Check about 800x550 and a full display too
(`../../DESIGN.md`, "Window size"):

```json
{ "session": "ui", "steps": [
  { "shot": "default" },
  { "viewport": "800x550" }, { "shot": "small" },
  { "viewport": "1728x1080" }, { "shot": "large" }
] }
```

## Poses

Poses ride the URL:

- `?theme=light|dark`, `?doubutsu=0|1`: appearance, seeded pre-paint.
  `?light=<id>` and `?dark=<id>` pick each appearance's doubutsu
  palette (the ids in `shared/themes.ts`, default `cream` and
  `charcoal`).
- `?peers=sm:connected,tp:connected,mini:online,pc:offline`: presence
  per device key (`sm` Studio Mac, `tp` Thinkpad, `mini` Mini, `pc`
  Work PC). The desktop default is `tp:connected`, and the web
  default adds `sm`.
- `?updates=sm,tp,mini`: the devices holding a staged update, by the
  same keys (default none). Every device runs 2.0.3 and the update is
  2.1.0, so the others count as behind it (the update toast, Update
  all).
- `?downloading=sm,tp,mini`: the devices downloading the update.
- `?crowd=<n>`: up to 20 more projects on Studio Mac, most holding
  their primary checkout alone, for the forest at the size where
  finding a project gets hard. Add `&crowdShared=1` to have terrier
  list them all and the Thinkpad hold most of them too, so nearly
  every project is terrier's and on a second device (the open
  project's header shows the paw and its devices).
- `?mirrorEngine=running|starting|stopped|unavailable`: every
  device's mirror engine (default `running`), for the reason the
  Mirror buttons give when it can't take a start.
- `?mirrored=1`: a mirror running from boot (Studio Mac's
  `brave-badger` with a copy on Thinkpad), for the surfaces that list
  mirrors (the Live page, the sidebar's fold).
- `?liveEdge=1`: the Live page's hard cases beside its usual runs: a
  very long script name, a worktree running five scripts, a run in a
  worktree its device no longer lists, a run on Mini (which takes no
  commands from here: add `&peers=tp:connected,mini:connected`), and a
  forward tied to no worktree at another local port.
- `?missing=1`: a project on Studio Mac (`tanuki-notes`) whose repo
  was moved by hand, so the sidebar lists it as missing. The repo is
  under `~/dev` now, for Locate… to find.
- `?view=inbox`: open the sidebar in its inbox view (the toggle flips
  it in-session either way).
- `?updatedFrom=<version>`: the build this window last ran, so the fake
  host's own 2.0.3 boots as an update from it and shows the update toast
  (e.g. `?updatedFrom=2.0.1`, whose "What's new" lists 2.0.2 and 2.0.3).
- `?checks=<variant>`: the CI rollup on PR #148 (worktree
  `happy-hummingbird`,
  `?to=/devices/dev_8f3ac2e1/projects/p_sm/worktrees/wt_sm_hum`), with
  the merge state GitHub would pair with it. Variants are the keys of
  `FAKE_CHECK_POSES` in `pullRequestFixtures.ts`: `none`,
  `single-passed`, `single-failing`, `passed`, `passed-some-skipped`,
  `all-skipped`, `auto-merge`, `pending`, `failing`, `failing-blocked`,
  `failing-and-pending`, `many`. Absent, it keeps two passing checks.
- `?reviews=<variant>`: the reviews on the same PR, keys of
  `FAKE_REVIEW_POSES`: `approved`, `approved-no-rule`,
  `changes-requested`, `required`, `required-unrequested`,
  `required-partial`, `requested`, `commented`. Absent, it has none
  and no review rule, so the reviews chip stays away. Pairs with
  `?checks=` (`?checks=pending&reviews=required`).
- `?prState=<pose>`: PR #148 in a state the CI poses don't reach,
  keys of `FAKE_PR_STATE_POSES`: `draft`, `closed` (without merging),
  `conflicts`, `behind`. Absent, it is open.
- Desktop: `?to=/account` navigates the memory router after mount. Web:
  the path itself is the route (`/account`, `/devices/...`).
- `?villageLife=1`: Village life on in this window's settings (the
  desktop's: the web shell has none). Off by default, as a fresh
  install has it.
- `?signedOut=1`: the desktop signed out of its account (the account
  status alone: the fixture peers stay), for the settings that need
  one.
- `?today=MM-DD` (or `YYYY-MM-DD`): the calendar day, for a villager's
  birthday (the sidebar cake and the worktree page's party).
- `?villagers=absent|downloading|ready|failed`: the villager data
  status, for the control beside Village life in Settings. The
  default is ready when the fake host holds a download (below), absent
  otherwise.
- `?visits=none`: an empty Visitors album (Settings, with Village
  life on). Without it the album is posed with a spread of visits.

## Controls

Runtime controls on `window.fakeHost`, for a `js` step:
`setPeer(deviceId, "connected" | "online" | "offline")`,
`setSocket(phase)`, `navigate(to)` (desktop, no reload),
`setMirrorConflicts(roots)` (holds those paths still on every mirror
started in this session, for the conflict chip. Start one first, since
the fixtures seed none), `worktree(deviceId, "add" | "remove", name,
{ projectId?, changedCount?, fields? })` (a worktree made, changed or
removed behind the app's back, the way `sm` or another device would,
for the villagers moving in and out, with changes to commit, and with
`"update"` and `fields` a git state posed on an existing row, such as
`{ detached: true }` or `{ hasUpstream: false }`), plus
`emitClient`/`emitHost` for raw broadcasts. What the page logs comes
back in each reply.

## Fixtures

Fixtures live in `fixtures.ts`. Each device has a small disk
there (`fakeDisks`) for the add-project dialog to browse, and adding or
cloning on one really registers the project, so it folds into the
sidebar the way a real one would. `bridge.ts` serves them and
answers any unhandled channel with a schema-derived stub (fabricated
arms allowed: this is a fake, not the fail-closed web bridge). The sync
verbs really mutate the fixture world, so the transplant and mirror
flows show their outcome: a posed mirror session cycles every few
seconds, keeps a history, and folds the peer's sidebar row into the
local one. The changes page keeps a working tree per worktree
(`changesFixtures.ts`, seeded from its `changedCount`), which ticking,
committing, discarding and pushing move.

The app downloads the villager faces and profiles from Nookipedia when
its user asks. The fake host serves its own copy from
`villager-data/`, which `pnpm villagers:fetch` downloads with
the app's own downloader (about 4 MB, once, served by
`villagerData.ts`). Without it the villager data reads as not
downloaded and no face shows. `/villager-icons.html` on the desktop
shell is a contact sheet of the faces over the same bridge, with
Village life on.
