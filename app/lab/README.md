# UI lab

Design-exploration harness: the real app UI mounted in a browser over
a fixture `window.api` (four devices, mixed presence, shared and
remote-only projects, two of them terrier-sourced), so every multi-device surface can be posed and
screenshotted without a device hub, a second machine, or Clerk. Dev-only;
nothing here ships.

Two flavors:

- **Desktop shell**: `pnpm lab` (port `LAB_PORT`). Mounts the desktop
  renderer (`renderer/App.tsx`), with the lab page posing as "Studio
  Mac" over a local forest.
- **Web shell**: `pnpm lab:web` (port `LAB_WEB_PORT`). Mounts the real web boot
  (`web/boot`). The page poses as an enrolled browser device, and every
  machine forest (Studio Mac included) is a peer. Under 768px wide it
  renders the phone layout.

Both ports come from port-pool, one pair per worktree, in
`.env.ports` (both scripts run `port-pool ensure` first), so labs in
different worktrees run side by side. Without port-pool, or in a
checkout it hasn't provisioned, they fall back to 5191 and 5192. A real `LAB_PORT` / `LAB_WEB_PORT` env var, or
`--port <port>` on either script, overrides the pooled port.

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
  same keys (default `tp`). Every device runs 2.0.3 and the update is
  2.1.0, so the others count as behind it (the update toast, Update
  all).
- `?downloading=sm,tp,mini`: the devices downloading the update.
- `?crowd=<n>`: up to 20 more projects on Studio Mac, most holding
  their primary checkout alone, for the forest at the size where
  finding a project gets hard. Add `&crowdShared=1` to have terrier
  list them all and the Thinkpad hold most of them too, so nearly
  every project is terrier's and on a second device (the open
  project's header shows the paw and its devices).
- `?view=inbox`: open the sidebar in its inbox view (the toggle flips
  it in-session either way).
- `?updatedFrom=<version>`: the build this window last ran, so the lab's
  own 2.0.3 boots as an update from it and shows the update toast
  (e.g. `?updatedFrom=2.0.1`, whose "What's new" lists 2.0.2 and 2.0.3).
- `?checks=<variant>`: the CI rollup on PR #148 (worktree
  `happy-hummingbird`,
  `?to=/devices/dev_8f3ac2e1/projects/p_sm/worktrees/5a0000000002`), with
  the merge state GitHub would pair with it. Variants are the keys of
  `LAB_CHECK_POSES` in `pullRequestFixtures.ts`: `none`, `single-passed`,
  `single-failing`, `passed`, `passed-some-skipped`, `all-skipped`, `auto-merge`,
  `pending`, `failing`, `failing-blocked`, `failing-and-pending`,
  `many`. Absent, it keeps two passing checks.
- Desktop: `?to=/devices` navigates the memory router after mount. Web:
  the path itself is the route (`/devices/...`).
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
  default is ready when the lab holds a download (below), absent
  otherwise.
- `?visits=none`: an empty Visitors album (Settings, with Village
  life on). Without it the album is posed with a spread of visits.

Runtime controls on `window.smLab`: `setPeer(deviceId, "connected" |
"online" | "offline")`, `setSocket(phase)`, `navigate(to)` (desktop),
`setMirrorConflicts(roots)` (holds those paths still on every mirror
started in this session, for the conflict chip. Start one first,
since the fixtures seed none), `worktree(deviceId, "add" | "remove",
name, { projectId?, changedCount? })` (a worktree made or removed
behind the app's back, the way `sm` or another device would, for the
villagers moving in and out, and with changes to commit), plus `emitClient`/`emitHost` for raw broadcasts. Console/warns/errors
collect in `window.smLabLog`.

The villager faces and profiles are never committed: the app downloads
them from Nookipedia when its user asks. The lab serves its own copy
from `lab/villager-data` (gitignored), which `pnpm villagers:fetch`
downloads with the app's own downloader (about 4 MB, once, served by
`lab/villagerData.ts`). Without it the villager data reads as
not downloaded and no face shows. `villager-icons.html` is a contact
sheet of the faces over the same bridge, with Village life on.

Fixtures live in `fixtures.ts`. Each device has a small disk there
(`labDisks`) for the add-project dialog to browse, and adding or
cloning on one really registers the project, so it folds into the
sidebar the way a real one would. `bridge.ts` serves them and answers
any unhandled channel with a schema-derived stub (fabricated arms
allowed: this is a lab, not the fail-closed web bridge). The sync
verbs really mutate the fixture world, so the transplant and mirror
flows show their outcome: a posed mirror session cycles every few
seconds, keeps a history, and folds the peer's sidebar row into the
local one.

Screenshots: `lab/shoot.mts` (playwright-core over system Chrome,
headless). Use it rather than a browser preview in the chat thread:
that browser runs on the viewer's machine and can't reach a dev server
here over a remote connection. Run
`node lab/shoot.mts shots.json outdir`. It shoots this worktree's
desktop lab (`LAB_PORT`). Point `LAB_ORIGIN` at any other lab origin,
such as the web shell's. Each shot is
`{ file, query, width?, height?, waitMs?, actions? }`, where the
actions (click, press, evaluate, wait) run before the capture:

```sh
pnpm lab
# in another terminal
cat > /tmp/shots.json <<'JSON'
[{ "file": "devices-dark", "query": "?theme=dark&to=/devices" },
 { "file": "phone", "query": "?theme=light", "width": 390, "height": 844 }]
JSON
node lab/shoot.mts /tmp/shots.json /tmp
```

For anything the shot format can't express, a one-off script can
`import { chromium } from "playwright-core"` (a dev dependency) and
launch `{ channel: "chrome", headless: true }`. Stop the lab when done.

Videos: `lab/record.mts`, the same harness recording a take instead of
taking a shot, with a drawn cursor so clicks are visible. Same
prerequisites plus Playwright's own ffmpeg (`pnpm exec playwright-core
install ffmpeg`, once). Run `node lab/record.mts takes.json outdir`. Each take has
the shot shape, with `click` taking a Playwright locator, `type` and
`paste` putting text into whatever has focus (keyed at a readable pace,
or all at once as a clipboard would), and a `waitFor` action that
blocks on visible text, which is how a take waits out a posed
transfer. Output is webm; set `FFMPEG` to a binary to get an mp4
beside it. The sync verbs are posed, so a recording shows the UI of a
flow, not a transfer.

## Views and scenes

The marketing site shows the app by rendering its React components at
build time, with no app running. That works for components that take
their data as props, which this calls views. A scene composes views
over the lab's fixtures into one of the site's pictures.

- **A view** is `FooView` in its own `FooView.tsx`, beside the component
  that feeds it. It takes plain data as props and renders it. It
  calls no hook that reads a query, the router, a store or `window`,
  and it imports no module that reads `window` or `window.api` as it
  loads (`lib/queryKeys`, `lib/localHost`, `hooks/remote/useHostScope`,
  the run and lifecycle stores, and anything that imports them). Type
  imports are fine, since they leave nothing behind. Pure leaves
  (`components/ui/*`'s primitives, `lib/*` helpers) are fine too.
- **The component that feeds it** keeps its name, props and behaviour.
  It calls the hooks and renders the view, so nothing changes for the
  rest of the app (sidebar/inbox/InboxRow.tsx and InboxRowView.tsx are
  the pattern).
- What used to be read inline becomes a prop: whether there is a local
  host (`hasLocalHost`), a dev build, the phone layout, the time
  (`now`, so "14m ago" holds still), a looked-up icon.
- Menus and dialogs a scene shows open are drawn inline, without their
  portals: `ui/menu-view.tsx` and `ui/modal-shell-view.tsx` carry the
  live ones' slots and classes.
- **A scene** is one picture: a component that takes no props, listed
  in `lab/scenes/index.ts` with the size it lays out at and, for a
  whole window, which window it is (the desktop app's or the web app on
  a phone). `pnpm test scenes` renders every one in Node, where
  anything that reaches for the app fails, and the marketing site
  renders them the same way.
- The scenes are put together from the lab's parts, which are the
  app's views over the fixtures: `LabWindow` (the shell, AppShellView,
  around a `sidebar` and a page), `LabSidebar` (either shell, either
  view, with a selected worktree), `WorktreeDetailPane` and
  `DevicesPane`. Where the live app fills a view's slot with a
  component that reads the app, a part fills it with that component's
  view.
- The parts read the fixtures through `lab/scenes/world/`: `index.ts`
  for what every scene reads, and a file per part of the app. Each is
  plain functions over the fixtures that hand them to the app's own
  pure builders (`buildInboxRows`, `mergeBoxState`,
  `pullLandingCollision`, ...). A rule the app applies (which rows
  the inbox holds, when a pull would collide) belongs in such a
  builder, called by the component and the scene alike, and never
  written a second time here.

A view should draw exactly what its component drew. To check, shoot
the lab before and after (`lab/shoot.mts`) and compare the images.
To see a scene beside the live app, the lab serves a viewer at
`/scenes.html?scene=<name>` (lab/scenes/viewer.tsx), which draws it at
its size and takes the lab's appearance poses. A scene poses as a
release build, so it lacks the dev marks the lab's brand header wears.
