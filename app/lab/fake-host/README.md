# The fake host

Runs the real UI in a browser backed by a fake page API. The fixture world includes four devices with mixed presence, shared and remote-only projects (two of them terrier-sourced), pull requests in every CI state, and villagers. Pose and capture every multi-device screen without a device hub, a second machine, or Clerk. This code is dev-only and nothing here ships.

There are two flavors, each served by a Vite dev server on this worktree's port from `.env.ports` (falling back to 5191 and 5192 without port-pool):

- **Desktop shell**: `pnpm fake-host` on `FAKE_HOST_PORT`. Mounts the desktop renderer ([`renderer/App.tsx`](../../renderer/App.tsx)), with the page posing as "Studio Mac" over a local forest.
- **Web shell**: `pnpm fake-host:web` on `FAKE_HOST_WEB_PORT`. Mounts the real web boot ([`web/boot`](../../web/boot.tsx)). The page poses as an enrolled browser device, so every machine forest (including Studio Mac) appears as a peer. Below 768px wide, it renders the phone layout.

Some ways to use it:

- **One screen, every state.** Step a pose through its values (each `?checks=` variant, presence per peer, `?crowd=` sizes) and capture each one. A code file loops over a list as easily as inline steps.
- **Side by side.** Open a session per theme, viewport, or shell (desktop and web) on the same pose, and use `on` to capture all of them in a single run.
- **Before and after.** Capture a screen, make your change (Vite reloads the page), and compare a new shot against the first using `matches`. Alternatively, run another checkout's fake host on its own port beside this one.
- **A flow, step by step.** Open a dialog, click through it as a user would, verify each stage with `expect`, and record video of the session for a reviewer. The sync verbs mutate the fake world, so the resulting outcome appears live.
- **Mid-session changes.** Use `window.fakeHost` to flip a peer's presence, set the hub socket's status, or make a worktree appear behind the app's back so you can observe how an already-open screen reacts. The socket status is only simulated: the web shell here runs on a fixture page API and never dials (no Colibrii device runs), so testing a real redial or inspecting its trace requires the real web client ([`../reliability/README.md`](../reliability/README.md)).
- **A slow host.** Call `window.fakeHost.setLatency(ms)` so every subsequent response arrives delayed by `ms` milliseconds, letting you inspect what a list, a fold, or a dialog renders while waiting.
- **A real patch.** Call `window.fakeHost.setPatch(patch)` so commit, branch, stash, and pull request diffs opened afterward read your own patch instead of the fixture's (such as `git show --format= --full-index <hash>` from any repository) when you need a diff the fixtures do not cover.

The marketing site runs this same bridge in-process for its live frames ([`frames.tsx`](frames.tsx)). Each frame mounts a desktop window of the app into an element on the marketing page, sharing one bridge and one client. The frames pose as the released app (with no dev badge or dev hotkeys), start on the sidebar's inbox view, and have no recorded last version so no update toast appears ([`marketing/README.md`](../../../marketing/README.md), "The frames").

What the fake host cannot test is anything below the bridge. Transfers, mirrors, and the hub are all simulated, and any channel not handled by the fixtures returns a stub derived from its schema, so a screen that renders here proves nothing about the real host behind it. Electron itself (native menus, deep links, the keychain, and native windows) is also absent. To test those, use device windows ([`../devices.md`](../devices.md)).

Open a session using weblab's `new`, passing this worktree's port as the address. Run `grep FAKE_HOST_ .env.ports` to print both ports. A fresh checkout has no `.env.ports` until the first `pnpm fake-host` (or any dev server) runs [`scripts/ensure-ports.mts`](../../scripts/ensure-ports.mts), which requests this checkout's ports from port-pool. Run `port-pool release <checkout>` to release them when removing a throwaway checkout. A server's first load compiles the app through the React Compiler and can exceed weblab's default timeout, so pass a longer timeout on the first `goto`. Below, `4752` and `4753` serve as example ports:

```json
{ "name": "ui", "address": 4752, "start": "pnpm fake-host", "path": "/?theme=dark&to=/account", "viewport": "920x720" }
```

```json
{ "name": "phone", "address": 4753, "start": "pnpm fake-host:web", "path": "/account?theme=light", "viewport": "390x844@3" }
```

Then pose and capture screens with `run` (see [`../weblab.md`](../weblab.md) for what it can do). Because the app scrolls inside its own panes, a `fullPage` shot shows no more of a long page, so make the viewport taller instead.

```json
{ "session": "ui", "steps": [
  { "goto": "/?theme=light&checks=failing&to=/devices/dev_8f3ac2e1/projects/p_sm/worktrees/a10000000002" },
  { "expect": "happy-hummingbird" },
  { "shot": "checks-failing" }
] }
```

Use the app window's default size (920x720) for the desktop shell rather than weblab's 1440x900 default. Check around 800x550 and a full display too ([`../../DESIGN.md`](../../DESIGN.md), "Window size"):

```json
{ "session": "ui", "steps": [
  { "shot": "default" },
  { "viewport": "800x550" }, { "shot": "small" },
  { "viewport": "1728x1080" }, { "shot": "large" }
] }
```

## Poses

Poses are set via URL query parameters:

- `?theme=light|dark`, `?doubutsu=0|1`: Sets appearance before first paint. `?light=<id>` and `?dark=<id>` select each appearance's doubutsu palette (using the IDs in [`packages/ui/src/lib/themes.ts`](../../../packages/ui/src/lib/themes.ts), with `cream` and `charcoal` as defaults).
- `?peers=sm:connected,mb:connected,mini:online,imac:offline`: Sets presence per device key (`sm` for Studio Mac, `mb` for MacBook, `mini` for Mini, `imac` for Work iMac). The desktop shell defaults to `mb:connected`, and the web shell adds `sm`.
- `?updates=sm,mb,mini`: Marks the listed devices (by the same keys, default none) as having a staged update. Every device runs 3.0.3 and the update is 3.1.0, so the other devices count as behind it (for the update toast and Update all).
- `?downloading=sm,mb,mini`: Marks the listed devices as downloading the update.
- `?migration=waiting|moving|stuck|done`: Sets the v3 migration page (`?to=/migration`) to that state (`MIGRATION_POSES` in [`stepsFixtures.ts`](../../../packages/ui/src/fixtures/stepsFixtures.ts)). Without it, there is nothing to migrate and `/migration` opens the app instead.
- `?fresh=1`: Poses Studio Mac as a fresh install with no projects, for checking the home screen a fresh install opens on.
- `?windows=sm,mb`: Marks the listed devices (by the same keys) as Windows machines, with paths on drive `C:` and Windows launchers, and lets the folder picker browse up from a drive to the drive list. Including `sm` also poses this window as a Windows viewer (Windows keys, file manager, and sidebar on the right).
- `?notSharing=mb,mini`: Turns sharing off on the listed devices (by the same keys), so they serve no data to this page.
- `?outdated=mb:terminals.scripts,mini:core`: Poses the listed devices as running another release of the app, specifying either the contract modules held at another version (whose calls are refused just as a real link refuses them) or `core` for a device this machine cannot link with at all. Pair with `?outdatedSide=this` to pose this device as the one on the older build.
- `?hubBlocked=update-required`: Poses this device's hub socket as blocked for `update-required`, `refused`, `revoked`, or `superseded`, showing the wording each state uses.
- `?crowd=<n>`: Adds up to 20 extra projects on Studio Mac, most with only their primary checkout, to test a forest large enough that finding a project gets hard. Add `&crowdShared=1` to have terrier list all of them and put most of them on MacBook as well, so nearly every project is terrier-sourced and on a second device (every row shows its devices, and the open project's header shows the paw too).
- `?mirrorEngine=running|starting|stopped|unavailable`: Sets every device's mirror engine state (default `running`), to test the reason the Mirror buttons show when the engine cannot accept a start.
- `?mirrorRefused=1`: Causes the copy's device to refuse every mirror start because it cannot create the symlinks the original tracks, showing the wording its landing returns (or the Windows wording when paired with `?windows=`).
- `?crlfScripts=1`: Poses every mirror start's original as tracking scripts with Windows line endings (as a Windows checkout produces), to show the Live step's line about them on a non-Windows copy (pair with `?windows=sm` to make Studio Mac the original).
- `?mirrored=1`: Starts a mirror from boot (Studio Mac's `brave-badger` with a copy on MacBook), for surfaces that list mirrors (the Live page and the sidebar's fold).
- `?liveEdge=1`: Adds edge cases beside the usual runs on the Live page: a very long script name, a worktree running five scripts, a run in a worktree its device no longer lists, a run on Mini (which accepts no commands from here, so add `&peers=mb:connected,mini:connected`), and a port forward at a different local port that is tied to no worktree.
- `?gh=missing|signed-out`: Poses the GitHub CLI on every device as not installed (`missing`) or not signed in (`signed-out`), for surfaces that explain why they cannot use it (such as Publish to GitHub in the add-project dialog).
- `?missing=1`: Adds a project on Studio Mac (`tanuki-notes`) whose repo was moved by hand, so the sidebar lists it as missing. The repo sits under `~/dev` for `Locate…` to find.
- `?view=inbox`: Opens the sidebar in its inbox view (the toggle switches it in-session either way).
- `?updatedFrom=<version>`: Sets the build this window last ran so the fake host's 3.0.3 boots as an update from it and shows the update toast (for example, `?updatedFrom=3.0.1` lists 3.0.2 and 3.0.3 under "What's new").
- `?checks=<variant>`: Sets the CI rollup on PR #148 (worktree `happy-hummingbird`, `?to=/devices/dev_8f3ac2e1/projects/p_sm/worktrees/a10000000002`), paired with the merge state GitHub would report for it. Variants are the keys of `FAKE_CHECK_POSES` in [`pullRequestFixtures.ts`](../../../packages/ui/src/fixtures/pullRequestFixtures.ts): `none`, `single-passed`, `single-failing`, `passed`, `passed-some-skipped`, `all-skipped`, `auto-merge`, `pending`, `failing`, `failing-blocked`, `failing-and-pending`, `many`. When omitted, PR #148 has two passing checks.
- `?stack=merged`: Marks the stack of three PRs across Studio Mac and MacBook (`fix-stale-locks`, `exp/terrier-sync`, `port-pool-retry`) as all landed, so the closed-PR box offers stack cleanup.
- `?reviews=<variant>`: Sets the reviews on PR #148 using the keys of `FAKE_REVIEW_POSES`: `approved`, `approved-no-rule`, `changes-requested`, `required`, `required-unrequested`, `required-partial`, `requested`, `commented`. When omitted, PR #148 has no reviews and no review rule, so the reviews chip stays hidden. Pairs with `?checks=` (e.g. `?checks=pending&reviews=required`).
- `?prState=<pose>`: Puts PR #148 in a state the CI poses do not reach, using the keys of `FAKE_PR_STATE_POSES`: `draft`, `closed` (without merging), `conflicts`, `behind`. When omitted, the PR is open.
- Desktop: `?to=/account` navigates the memory router after mount. Web: the URL path itself is the route (`/account`, `/devices/...`).
- `?villageLife=1`: Turns Village life on in this window's settings (desktop only, since the web shell has no Village life setting). Off by default, matching a fresh install.
- `?signedOut=1`: Poses the desktop as signed out of its account (account status only, with the fixture peers kept), for testing settings that require an account.
- `?today=MM-DD` (or `YYYY-MM-DD`): Overrides the calendar day to test a villager's birthday (the sidebar cake and the worktree page's party).
- `?villagers=absent|downloading|ready|failed`: Sets the villager data status for the control beside Village life in Settings. Defaults to `ready` when the fake host has downloaded villager data (see below), and `absent` otherwise.
- `?visits=none`: Poses an empty Visitors album in Settings (with Village life on). Without it, the album displays a spread of visits.

## Controls

Runtime controls live on `window.fakeHost` for use in `js` steps. Anything the page logs is returned in each reply.

- `setPeer(deviceId, "connected" | "online" | "offline")`: Sets a peer's presence.
- `setSocket(phase)`: Sets the hub socket phase.
- `setLatency(ms)`: Delays subsequent responses by `ms` milliseconds.
- `navigate(to)`: Navigates the desktop router without reloading.
- `setMirrorConflicts(roots)`: Keeps those paths in conflict on every mirror started in this session, for testing the conflict chip. Start a mirror first, since the fixtures seed none.
- `worktree(deviceId, "add" | "remove", name, { projectId?, changedCount?, fields? })`: Simulates a worktree created, modified, or removed behind the app's back (as `sm` or another device would), for testing villagers moving in and out or uncommitted changes. Pass `"update"` with `fields` to pose git state on an existing row, such as `{ detached: true }` or `{ hasUpstream: false }`.
- `emitClient` / `emitHost`: Emit raw client or host broadcasts.

## Fixtures

Fixtures live in `@shigomori/ui` ([`packages/ui/src/fixtures`](../../../packages/ui/src/fixtures)), sharing the same fixture world that the scenes render: [`fixtures.ts`](../../../packages/ui/src/fixtures/fixtures.ts) defines the devices, projects, and worktrees, with one file per area beside it. Each worktree ID is twelve hex digits, as the contracts require: Studio Mac's `shigoto-no-mori` worktrees start with `a1` (`a10000000002` is `happy-hummingbird`). Each device has a small simulated disk (`fakeDisks`) for the add-project dialog to browse. Adding or cloning a project on a device registers it in fixture state, so it appears in the sidebar just like a real project.

[`bridge.ts`](bridge.ts) serves these fixtures as the links of the page's client runtime ([`renderer/lib/runtime`](../../renderer/lib/runtime)), replacing the real shell and host. After any push or call on a module's wire, that module's view re-reads its list (or its settings), matching how a real host view updates when state changes. Any unhandled channel returns a schema-derived stub (fabricated arms are allowed because this is a fake, not the fail-closed web bridge). The sync verbs mutate the fixture world so transplant and mirror flows show real outcomes: a posed mirror session cycles every few seconds, records a history, and folds the peer's sidebar row into the local row. Landing a move or mirror requires the repo to exist on the target device. The initial clone that a real move or mirror runs on a device without the repo is not simulated, so that case fails at landing. The changes page maintains a working tree per worktree ([`changesFixtures.ts`](../../../packages/ui/src/fixtures/changesFixtures.ts), seeded from its `changedCount`, with files past the eighth being new (`added`) files in an unignored build folder), which updates as you tick, commit, discard, and push.

The real app downloads villager faces and profiles from Nookipedia when the user asks. The fake host serves its own local copy from `villager-data/` (served by [`villagerData.ts`](villagerData.ts)), downloaded once via `pnpm villagers:fetch` using the app's own downloader (about 4 MB). Without that download, villager data reads as not downloaded and no faces appear. `/villager-icons.html` on the desktop shell shows a contact sheet of the faces over the same bridge, with Village life on.
