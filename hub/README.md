# sm device hub

Cloudflare Worker that relays frames between a Clerk account's sm
devices when they are not on the same LAN (v2 step 4). Every device
holds one outbound websocket to its account's `DeviceHub` Durable
Object, which forwards opaque envelopes between them. No sm logic runs
here: the Worker verifies Clerk tokens, keeps a device registry in D1,
mints short-lived connection tickets and forwards frames it never
parses. The wire contract lives in `../shared/hub/protocol.ts`.

This directory is a standalone pnpm project (like `cli/` is a
standalone Go module) with its own lockfile. Install and run its
scripts from `hub/`. One caveat on isolation: the shared contract it
imports (`../shared/hub/protocol.ts` and the `frames.ts` that file
re-exports) lives outside `hub/`, so its `zod` import resolves from
the repo-root `node_modules`, not `hub/node_modules`. Both installs
pin the same zod, so a repo-root install is a prerequisite for building
or deploying the shared half.

## Domains (production)

Two zones on the one Cloudflare account, both required at launch.
Dev needs only the `shigomori.com` zone for its own Worker host
(`hub-dev.shigomori.com`, below): dev web builds point at Vercel
preview URLs, and dev tunnels share the tunnel zone below.

| Host | Serves | Pinned where |
|---|---|---|
| `shigomori.com` | Marketing site | Nowhere in code |
| `app.shigomori.com` | Web client (Vercel) | Baked into desktop builds as `SM_ACCOUNT_WEB_ORIGIN` |
| `hub.shigomori.com` | This Worker (Workers custom domain) | Baked into desktop builds as `SM_DEVICE_HUB_URL` |
| `hub-dev.shigomori.com` | The dev Worker (Workers custom domain, `env.dev` in `wrangler.jsonc`) | Baked into dev builds as `SM_DEVICE_HUB_URL` |
| `sm-<hash>.shigomori.link` | One per device, written by this Worker | The `TUNNEL_*` secrets, never a build |
| `clerk.shigomori.com` | Clerk production Frontend API | Clerk prod instance (DNS-only CNAME). `vercel.json` `script-src` still lists only the dev pattern, add it when going live |
| `clkmail.shigomori.com` + DKIM | Clerk sign-in email | Clerk prod instance (DNS-only) |
| `accounts.shigomori.com` | Clerk Account Portal, optional | Clerk prod instance |

Rules the layout depends on:

- **Every host is one label deep.** Cloudflare's Universal SSL covers
  the apex and one subdomain level only, so `x.y.shigomori.com` gets no
  edge certificate without Advanced Certificate Manager. This is why
  tunnels get their own zone instead of `*.tunnel.shigomori.com`.
- **The tunnel zone holds nothing else.** The Worker's API token needs
  DNS edit on the whole zone it writes into. Keeping `shigomori.link`
  tunnel-only means that token can never touch the brand's records.
  Device hostnames hash the Clerk user id, which differs per Clerk
  instance, so dev and prod devices coexist in the zone.
- **`app` and `hub` are baked into every desktop build.** Renaming
  either means a new desktop release, and the Origin gate on the
  direct listener matches `SM_ACCOUNT_WEB_ORIGIN` exactly. Pick once.
- **Clerk hosts must be DNS-only** (grey cloud), which Clerk requires
  for its CNAME verification. Add them when the production Clerk
  instance is created, not before.

## Deploy

Two environments live in `wrangler.jsonc`: the top level is
production (`shigomori-hub`) and `env.dev` is `shigomori-hub-dev`.
`pnpm run deploy` targets dev and `pnpm run deploy:prod` production,
so a bare deploy never lands on production by accident. Each has its
own D1 database (ids pinned in the config) and its own secrets, set
with `--env dev` for dev and no flag for production. Production stays
undeployed until launch. Everything below is written for dev, drop
`--env dev` for the production equivalent.

Prerequisites: a Cloudflare account, a Clerk application, and
`pnpm install` run in this directory.

1. Create the database, if it does not exist yet, and paste the
   printed id into the matching `database_id` in `wrangler.jsonc`:

   ```sh
   pnpm exec wrangler d1 create shigomori-hub-dev
   ```

2. Apply the migrations:

   ```sh
   pnpm exec wrangler d1 migrations apply shigomori-hub-dev --remote --env dev
   ```

3. Set the Clerk secret key of the matching Clerk instance (from the
   Clerk dashboard, API keys):

   ```sh
   pnpm exec wrangler secret put CLERK_SECRET_KEY --env dev
   ```

4. Deploy:

   ```sh
   pnpm run deploy
   ```

The dev deploy also creates the `hub-dev.shigomori.com` custom domain
(DNS record and certificate) and serves no workers.dev route: the
workers.dev host carries the account's subdomain label, which
Cloudflare derives from the account email. At launch production gets
the same treatment with `hub.shigomori.com`, pinned in the top-level
config rather than `env.dev`.

Deploy order when a message cap shrinks (as with the 1 MiB to 64 KiB
`MAX_HUB_MESSAGE_BYTES` change): update all devices BEFORE
redeploying the Worker. The devices' inbound socket bound stays
tolerant at the old cap for exactly this window, so a
not-yet-redeployed Worker forwarding an old peer's oversize frame does
not kill a new client's control-plane socket. The reverse skew (an old
app talking through a new Worker) degrades softly instead: its
oversize sends get nacked and the calls time out, which is acceptable
during the owner's own rollout.

Devices heartbeat their hub socket with a bare `ping` text that the
Durable Object answers `pong` through the hibernation runtime's
auto-response (`shared/hub/protocol.ts`), so a socket a NAT or a sleep
killed is found and redialed within seconds. Deploy the Worker BEFORE
shipping devices that heartbeat: an old Worker drops the ping as a
malformed envelope, so a new device sees no pong and redials it once a
minute until the Worker is redeployed (it keeps working meanwhile, just
noisily). The reverse skew is silent: an old device never pings and the
auto-response never fires.

The Worker serves any browser origin (`Access-Control-Allow-Origin:
*`) and needs no origin config. Every route authenticates from an
explicit `Authorization` bearer, never from a cookie or any other
ambient credential, so a cross-origin page can obtain nothing a plain
unauthenticated request could not: it cannot read another origin's
localStorage to forge the header. The desktop's `SM_ACCOUNT_WEB_ORIGIN`
(below) is a separate gate on a separate process and is NOT paired with
anything here.

### Per-device tunnels (needed for devices off the LAN)

With the tunnel env configured, `POST /tunnel` provisions one named
Cloudflare Tunnel per device (v2 step 10, slice B): the Worker creates
or reuses the tunnel, points its remotely managed ingress at the
device's loopback direct listener, writes a proxied CNAME under
`TUNNEL_DOMAIN`, and returns the connector run token the app hands to
the `cloudflared` the app ships. Tunnel data never touches the Worker.
Unset, the tunnel route answers a typed "not configured", devices
advertise no tunnel candidate, and since data is direct or nothing two
devices on different networks cannot reach each other at all (the
Devices page says so on the this-device row).

Prerequisites: a DNS zone on the same Cloudflare account that holds
nothing but tunnels (`shigomori.link`, with the per-device CNAMEs at its
apex so they stay one level deep, which is all Universal SSL covers),
and an API token with Cloudflare Tunnel edit on the account and DNS
edit on that one zone. One zone serves both environments: device
names hash the Clerk user id, which differs per Clerk instance. Devices need
nothing installed: the app bundles a pinned `cloudflared`
(`shared/cloudflaredDist.mts`, fetched at package time and by
`pnpm start`). The `cloudflaredPath` device config key overrides it,
and PATH is the fallback for a build that carries none.

Set all four as secrets (dashboard-set plain vars do not survive a
deploy, and the values do not belong in the config file):

```sh
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --env dev
pnpm exec wrangler secret put CF_ACCOUNT_ID --env dev
pnpm exec wrangler secret put TUNNEL_ZONE_ID --env dev
pnpm exec wrangler secret put TUNNEL_DOMAIN --env dev
```

- `CLOUDFLARE_API_TOKEN` - the API token above.
- `CF_ACCOUNT_ID` - the Cloudflare account id.
- `TUNNEL_ZONE_ID` - the tunnel zone's id.
- `TUNNEL_DOMAIN` - the zone apex, e.g. `example.link`.

Revoking a device best-effort deletes its tunnel and DNS record.

## App-side account configuration

The desktop app's Account settings (sign in, enroll this device, view the
account's device registry) are driven by non-secret environment variables.
Packaged builds take them from the environment **at build time**: set them
when running `pnpm run package` / `pnpm run make` and they are baked into
the bundle, because an app launched from Finder or the Dock inherits
launchd's environment, not a shell's, and would otherwise never see them.
Environment variables present at launch still override the baked values.
They are empty by default, so a build made without them ships with the
Account section showing a "not configured" state and sign-in disabled.
None of these are secrets, so they are safe to bake into a build. Never
commit real values.

- `SM_DEVICE_HUB_URL` - the deployed Worker's base URL,
  `https://hub-dev.shigomori.com` for dev builds and
  `https://hub.shigomori.com` for production. The app joins the device and
  ticket routes onto this.
- `SM_ACCOUNT_CLERK_PUBLISHABLE_KEY` - the publishable key
  (`pk_test_...` / `pk_live_...`) of the same Clerk application whose
  secret key the Worker holds. The clients mount Clerk's embedded
  sign-in with it.
- `SM_ACCOUNT_WEB_ORIGIN` - optional, the exact origin of the deployed
  web client. The desktop app's direct listener admits browser dials
  from exactly this origin so the web client can dial wss tunnel URLs;
  without it those dials die at the desktop's Origin gate (the host
  logs the refused origin, throttled). Unset, only Origin-less and
  app-local clients are admitted, as before. Unlike the device hub, this
  gate stays strict on purpose: it guards a loopback listener on the
  user's own machine, which any page they visit can reach.

Sign-in itself is Clerk's embedded components: both clients mount
`ClerkProvider` with the publishable key (the desktop over
`@clerk/electron`'s main-process bridge, the web client with plain
`@clerk/react`), and after Clerk reports a session the client mints a
fresh session token and forwards it to the Worker as the enroll
bearer. The Worker verifies it as a Clerk session JWT
(`verifyToken` with the secret key) and keys the device registry on
its `sub`. The Worker verifies, the app never does.

One REQUIRED piece of Clerk instance configuration: the desktop
renderer lives on a custom-scheme origin and authenticates Clerk's
Frontend API with an `Authorization` header, which Clerk rejects from
an origin it does not know (`origin_authorization_headers_conflict`,
the same rule browser extensions hit). Add both renderer origins to
the instance's `allowed_origins` once per instance:

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" \
  -H "Content-type: application/json" \
  -d '{"allowed_origins": ["shigomori://app", "shigomori-dev://app"]}'
```

Without it, desktop sign-in fails on every Frontend API call after the
first (the web client is unaffected: a browser origin authenticates
the browser way). For macOS passkey support later, the dashboard's
Native applications page must also have the Native API enabled.

Social (browser-redirect) sign-in works in `pnpm start` on macOS: the
dev launcher (scripts/dev-electron.mts) clones Electron.app into a
gitignored per-worktree bundle that claims `shigomori-dev://` with
LaunchServices, and runs the dev app from it, so the redirect
deep-links back to the running dev process. With several dev worktrees
the most recently launched one owns the scheme. On Linux and Windows
dev stays unbundled and social sign-in still needs a packaged build
(email-code sign-in works everywhere). The dev bundle registers its
own plist, so the packaged app's `shigomori://` registration
(forge.config.ts protocols) is not exercised by dev sign-in: verify
social providers against a packaged build before a release that
touches it.

The web deploy's CSP (vercel.json) allowlists Clerk's script host as
`https://*.clerk.accounts.dev`, which covers development instances. A
production (`pk_live`) instance serves Clerk's UI from your own
`clerk.<domain>` Frontend API host instead, so add that origin to
`script-src` when going live.

For local development, put the account service values above in a gitignored
`.env.local` in the repo root (simple `KEY=value` lines). Both the
desktop and the web build read it. Baked and real environment variables
override it, and packaged builds never read it.

## Develop and test

```sh
pnpm run dev    # wrangler dev with local bindings
pnpm run check  # typecheck plus the vitest suite
pnpm run test   # just the suite
```

The suite runs inside workerd via @cloudflare/vitest-pool-workers with
real (local) D1, Durable Object and websocket implementations. Clerk
is stubbed through the `createWorker(deps)` seam, so no network or
real credentials are needed. For `wrangler dev` against real Clerk,
put `CLERK_SECRET_KEY` in a local `.dev.vars` (gitignored).
