# UI lab

Design-exploration harness: the real app UI mounted in a browser over
a fixture `window.api` (four devices, mixed presence, shared and
remote-only projects), so every multi-device surface can be posed and
screenshotted without a device hub, a second machine, or Clerk. Dev-only;
nothing here ships.

Two flavors:

- **Desktop shell**: `pnpm lab` (port 5191). Mounts the desktop
  renderer (`renderer/App.tsx`), with the lab page posing as "Studio
  Mac" over a local forest.
- **Web shell**: `pnpm lab:web` (port 5192). Mounts the real web boot
  (`web/boot`). The page poses as an enrolled browser device, and every
  machine forest (Studio Mac included) is a peer. Under 768px wide it
  renders the phone layout.

Other sessions may hold those ports. Pass `--port <free port>` to
either script to run beside them.

Poses ride the URL:

- `?theme=light|dark`, `?doubutsu=0|1`: appearance, seeded pre-paint.
- `?peers=sm:connected,tp:connected,mini:online,pc:offline`: presence
  per device key (`sm` Studio Mac, `tp` Thinkpad, `mini` Mini, `pc`
  Work PC). The desktop default is `tp:connected`, and the web
  default adds `sm`.
- `?updates=sm,tp,mini`: the devices holding a staged update, by the
  same keys (default `tp`).
- `?view=inbox`: open the sidebar in its inbox view (the toggle flips
  it in-session either way).
- `?checks=<variant>`: the CI rollup on PR #148 (worktree
  `happy-hummingbird`, `?to=/projects/p_sm/worktrees/wt_sm_hum`), with
  the merge state GitHub would pair with it. Variants are the keys of
  `LAB_CHECK_POSES` in `bridge.ts`: `none`, `single-passed`,
  `single-failing`, `passed`, `passed-some-skipped`, `all-skipped`,
  `pending`, `failing`, `failing-blocked`, `failing-and-pending`,
  `many`. Absent, it keeps two passing checks.
- Desktop: `?to=/devices` navigates the memory router after mount. Web:
  the path itself is the route (`/devices/...`).
- `?villageLife=1`: Village life on in every device's settings (off
  by default, as a fresh install has it).
- `?villagers=absent|downloading|ready|failed`: every device's villager
  data status, for the control under Village life in Settings. The
  default is ready when the lab holds a download (below), absent
  otherwise.

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

Screenshots: `lab/shoot.mjs` (playwright-core over system Chrome,
headless). Use it rather than a browser preview in the chat thread:
that browser runs on the viewer's machine and can't reach a dev server
here over a remote connection. Run
`node lab/shoot.mjs shots.json outdir`, with `LAB_ORIGIN` pointing at
the lab's origin when it isn't the desktop default
(`http://localhost:5191/`). Each shot is
`{ file, query, width?, height?, waitMs?, actions? }`, where the
actions (click, press, evaluate, wait) run before the capture:

```sh
pnpm lab --port 5291
# in another terminal
cat > /tmp/shots.json <<'JSON'
[{ "file": "devices-dark", "query": "?theme=dark&to=/devices" },
 { "file": "phone", "query": "?theme=light", "width": 390, "height": 844 }]
JSON
LAB_ORIGIN=http://localhost:5291/ node lab/shoot.mjs /tmp/shots.json /tmp
```

For anything the shot format can't express, a one-off script can
`import { chromium } from "playwright-core"` (a dev dependency) and
launch `{ channel: "chrome", headless: true }`. Stop the lab when done.

Videos: `lab/record.mjs`, the same harness recording a take instead of
taking a shot, with a drawn cursor so clicks are visible. Same
prerequisites plus Playwright's own ffmpeg (`pnpm exec playwright-core
install ffmpeg`, once). Run `node lab/record.mjs takes.json outdir`. Each take has
the shot shape, with `click` taking a Playwright locator, `type` and
`paste` putting text into whatever has focus (keyed at a readable pace,
or all at once as a clipboard would), and a `waitFor` action that
blocks on visible text, which is how a take waits out a posed
transfer. Output is webm; set `FFMPEG` to a binary to get an mp4
beside it. The sync verbs are posed, so a recording shows the UI of a
flow, not a transfer.
