# UI lab

Design-exploration harness: the real app UI mounted in a browser over
a fixture `window.api` (four devices, mixed presence, shared and
remote-only projects), so every multi-device surface can be posed and
screenshotted without a device hub, a second machine, or Clerk. Dev-only;
nothing here ships.

Two flavors:

- **Desktop shell**: `pnpm exec vite --config vite.lab.config.ts`
  (port 5191). Mounts the desktop renderer (`renderer/App.tsx`), with
  the lab page posing as "Studio Mac" over a local forest.
- **Web shell**: `pnpm exec vite --config vite.weblab.config.ts`
  (port 5192). Mounts the real web boot (`web/boot`). The page
  poses as an enrolled browser device, and every machine forest
  (Studio Mac included) is a peer.

Poses ride the URL:

- `?theme=light|dark`, `?doubutsu=0|1`: appearance, seeded pre-paint.
- `?peers=sm:connected,tp:connected,mini:online,pc:offline`: presence
  per device key (`sm` Studio Mac, `tp` Thinkpad, `mini` Mini, `pc`
  Work PC). The desktop default is `tp:connected`, and the web
  default adds `sm`.
- `?view=inbox`: open the sidebar in its inbox view (the toggle flips
  it in-session either way).
- Desktop: `?to=/devices` navigates the memory router after mount. Web:
  the path itself is the route (`/devices/...`).

Runtime controls on `window.smLab`: `setPeer(deviceId, "connected" |
"online" | "offline")`, `setSocket(phase)`, `navigate(to)` (desktop),
plus `emitClient`/`emitHost` for raw broadcasts. Console/warns/errors
collect in `window.smLabLog`.

Fixtures live in `fixtures.ts`. `bridge.ts` serves them and answers
any unhandled channel with a schema-derived stub (fabricated arms
allowed: this is a lab, not the fail-closed web bridge). The sync
verbs really mutate the fixture world, so the transplant and mirror
flows show their outcome: a posed mirror session cycles every few
seconds, keeps a history, and folds the peer's sidebar row into the
local one.

Screenshots: `lab/shoot.mjs` (playwright-core over system Chrome;
playwright-core is not a repo dependency, so run it from a scratch dir
that has it installed). Run `node shoot.mjs shots.json outdir`, with
`LAB_ORIGIN` pointing at the web flavor's port for web-shell shots.
Each shot is `{ file, query, width?, height?, waitMs?, actions? }`.

Videos: `lab/record.mjs`, the same harness recording a take instead of
taking a shot, with a drawn cursor so clicks are visible. Same
prerequisites plus Playwright's own ffmpeg (`playwright-core install
ffmpeg`, once). Run `node record.mjs takes.json outdir`. Each take has
the shot shape, with `click` taking a Playwright locator and a
`waitFor` action that blocks on visible text, which is how a take
waits out a posed transfer. Output is webm; set `FFMPEG` to a binary
to get an mp4 beside it. The sync verbs are posed, so a recording
shows the UI of a flow, not a transfer.
