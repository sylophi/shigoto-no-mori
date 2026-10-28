# sm device hub

Cloudflare Worker that keeps a Clerk account's sm devices in touch.
Every device holds one outbound websocket to its account's `DeviceHub`
Durable Object, which tells each device which others are online and
the key each enrolled with, and forwards the small opaque envelopes
they use to broker direct connections (a device asks a peer how to
dial it, the peer answers with its addresses and one-time tickets).
Data never passes through here: it flows over the device links
those answers set up. No sm logic runs here either: the Worker
verifies Clerk tokens, keeps a device registry in D1, mints
short-lived connection tickets and forwards envelopes it never
parses.

## Keys and sealed envelopes

Each device makes an X25519 key pair at every enrollment and sends
the public half with it (`publicKey` on the enroll body), which the
registry keeps in the device's row, replacing the last. When a socket
is admitted the object reads the row and tags the socket with the
key, and the presence roster names every online device with its key.
That roster is how a device knows its peers' keys: the hub is the
trust root for them, as it is for which devices exist. A row without
a key (a v2 enrollment) has its socket refused. The device's own v2
credential holds no key either, so the app reads as signed out and
enrolls again to make one: on its own where its Clerk session lives,
after a sign-in where it lapsed.

What a device relays to another is the connectInfo ask or its answer
sealed as a Noise handshake message to the addressed device's key
(`app/shared/hub/link.ts`), as the envelope's `frame`: a string the
object copies without reading, sent under the size limit. A frame
that is not a string is dropped like any malformed envelope. So the
hub reads only the addressing: who sent it and to whom.
The device an ask is addressed to remembers each one it answers for
ten minutes from receipt, by its own clock, so one the hub replays,
under any id, is dropped. The HTTP routes are the shared
`HubApi` (`packages/contracts/src/hubApi.ts`), served on Effect's
`http-api` and called by the app through the client derived from it,
and the socket's envelopes are `packages/contracts/src/hubProtocol.ts`.

Inside, the Worker (`src/worker.ts`) authenticates each route by its
bearer tier, reads and writes the registry through the `Registry`
service (`src/Registry.ts`), and calls the account's object's methods
directly. The object (`src/hubObject.ts`) keeps its unconsumed tickets
in its own SQLite storage through `@effect/sql-sqlite-do`
(`src/Tickets.ts`, which migrates its table as the object starts), and
takes a fetch only for the websocket upgrade.

This directory is a package of the repo's pnpm workspace: install from
the repo root, and run its scripts from `hub/`.

## Domains (production)

Two zones on the one Cloudflare account, both required in production.
Dev needs only the `shigomori.com` zone for its own Worker and web
hosts (`hub-dev` and `app-dev`, below); dev tunnels share the tunnel
zone below.

| Host | Serves | Pinned where |
|---|---|---|
| `shigomori.com` | Marketing site | Nowhere in code |
| `app.shigomori.com` | Web client (Vercel) | Baked into desktop builds as `SM_ACCOUNT_WEB_ORIGIN` |
| `hub.shigomori.com` | This Worker (Workers custom domain) | Baked into desktop builds as `SM_DEVICE_HUB_URL` |
| `hub-dev.shigomori.com` | The dev Worker (Workers custom domain, `env.dev` in `wrangler.jsonc`) | Baked into dev builds as `SM_DEVICE_HUB_URL` |
| `app-dev.shigomori.com` | Dev web client (Vercel) | Baked into dev builds as `SM_ACCOUNT_WEB_ORIGIN`, which is an exact-match gate, so a per-deployment preview URL cannot serve |
| `sm-<hash>.shigomori.link` | One per device, written by this Worker | The `TUNNEL_*` secrets, never a build |
| `clerk.shigomori.com` | Clerk production Frontend API | Clerk prod instance (DNS-only CNAME) and the `vercel.json` `script-src` |
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
with `--env dev` for dev and no flag for production. Everything below
is written for dev, drop `--env dev` for the production equivalent.

Prerequisites: a Cloudflare account, a Clerk application, and
`pnpm install` run at the repo root.

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

4. Set the ticket signing key, any random string. It never leaves the
   Worker, so generate it straight into the prompt and keep no copy:

   ```sh
   openssl rand -base64 32 | pnpm exec wrangler secret put TICKET_SIGNING_KEY --env dev
   ```

   Without it the Worker answers ticket mints with a 500
   (`HubTicketSigningUnconfiguredError`), and no device can connect. Rotating it only
   voids the tickets in flight, which live for a minute anyway.

5. Deploy:

   ```sh
   pnpm run deploy
   ```

Each deploy also creates its custom domain (`hub-dev.shigomori.com`
or `hub.shigomori.com`, DNS record and certificate) and serves no
workers.dev route: the workers.dev host carries the account's subdomain
label, which Cloudflare derives from the account email.

Deploy order if `MAX_HUB_MESSAGE_BYTES` ever shrinks: first ship app
builds whose inbound socket bound (`maxPayload` in
`app/host/hub/connection.ts`) still reads the old size, then redeploy
the Worker. A device reading a frame over its bound closes the socket,
so a Worker still forwarding at the old size must never meet a device
that already enforces the new one.

Deploy order for a D1 migration: apply it, then deploy the Worker
that reads it, since that Worker's queries name what the migration
makes. A rename breaks the running Worker's queries until the new one
is live, so those two go back to back. A Worker that raises the floor
also waits until the app release at its protocol has reached the
devices ("The version floor", below).

Devices heartbeat their hub socket with a bare `ping` text that the
Durable Object answers `pong` through the hibernation runtime's
auto-response (`packages/contracts/src/hubProtocol.ts`), so a socket a NAT or a sleep
killed is found and redialed within seconds.

The pings are also the hub's word on a device: a socket that has sent
neither one nor any other message for more than 90 s (`SILENT_AFTER_MS` in `src/hubObject.ts`) is
closed with `4106` and leaves the roster, which a device redials on.
A laptop that sleeps leaves its socket open, and Cloudflare reports no
close for it. It is judged when the object runs anyway (an ask relayed
to the socket's device, a read or an announce of the roster), never on
an alarm, which would bill a request and wake the object each time.
Every build the floor admits pings; one that did not would be closed
every 90 s.

The Worker serves any browser origin (`Access-Control-Allow-Origin:
*`) and needs no origin config. Every route authenticates from an
explicit `Authorization` bearer, never from a cookie or any other
ambient credential, so a cross-origin page can obtain nothing a plain
unauthenticated request could not: it cannot read another origin's
localStorage to forge the header. The desktop's `SM_ACCOUNT_WEB_ORIGIN`
(below) is a separate gate on a separate process and is NOT paired with
anything here.

### The version floor

Every app request names its protocol in an `sm-protocol` header, and
the Worker refuses a build naming none, or one below
`HUB_PROTOCOL_FLOOR` (`packages/contracts/src/hubApi.ts`), with a 403
`HubUpdateRequiredError` whose `error` field is the sentence a v2 build
shows. The floor is `PROTOCOL_VERSION`, so a protocol bump raises it at
the hub's next deploy and turns away every build below it at once:
deploy the hub only once that release has reached the devices.

### Abuse limits

The hub is on the public internet and most of its routes answer
before any credential is checked, so a stranger can make it do billed
work. Nothing here is a security boundary (every route still
authenticates), it only bounds what that traffic can cost.

- The Worker rate-limits per client IP through two `ratelimits`
  bindings in `wrangler.jsonc`: 60 requests a minute on enroll and
  connect, the two routes that do real work for a caller with no
  credential (Clerk verification, a Durable Object), and 300 a minute
  on every other route, each by the route the request matched however
  it spelled its path (a path no route matches does no work and is not
  counted). Over budget answers `429` with `Retry-After`.
  The counters are per Cloudflare location and approximate, which is
  fine for a cost guard.
- Connection tickets are signed (`TICKET_SIGNING_KEY`), so
  `GET /connect` cannot be used to instantiate a Durable Object under
  a name of the caller's choosing. A forged ticket is a `403` from the
  Worker. A ticket is bound to the credential it was minted with:
  enrolling a device again rotates its credential and closes its
  sockets (`4104`), and each dials again with the new credential; its
  unspent tickets carry the old one, which admission refuses.
- A device holds at most `MAX_DEVICE_CONNECTIONS` (32) sockets,
  whatever its kind. A desktop holds one and a browser profile one per
  tab; past the cap the device's oldest socket gives way.
- A socket may send a burst of 300 messages, refilled at 30 a second,
  and nothing longer than `MAX_HUB_MESSAGE_BYTES`; past either it is
  closed (`4105`, `1009`) and its device dials again. Measured on the
  dev hub, a socket sends two messages a second at most (a dial's
  connectInfo ask and answer, per peer), so an account at its device
  cap asks 30 at once: the budget is ten times that. Terminal and file
  traffic never ride this socket.
- Enrollment is admitted in the account's Durable Object, one at a
  time, so enrollments arriving together cannot pass the device cap.
- Workers Logs keeps what the code logs, with invocation logs off:
  they would record request URLs, and the connect route carries its
  ticket in one.
- The Worker's limiter runs inside the Worker, so a limited request is
  still a billed Worker invocation. Only a rule at the zone stops a
  flood before it is billed. Set one up once, in the Cloudflare
  dashboard under the `shigomori.com` zone, Security, WAF, Rate
  limiting rules: count by IP and block above a threshold comfortably
  over the Worker's own, 200 requests per 10 seconds fits. The free
  plan gives one rule, a 10 second window, and only the path to match
  on, so there the rule matches every path (`/*`) and covers the whole
  zone, which no person browsing the site comes near. A paid zone can
  narrow it to the two hub hostnames. Pair it with a usage
  notification (Notifications, Usage Based Billing) so a bill that
  does grow is noticed the same day.

### Per-device tunnels (needed for devices off the LAN)

With the tunnel env configured, `POST /tunnel` provisions one named
Cloudflare Tunnel per device: the Worker creates
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
names hash the Clerk user id, which differs per Clerk instance. For
the tunnels, the zone also needs one wildcard record: type A, name
`*`, IPv4 `192.0.2.1` (an address the edge can't reach), proxied, so
a device's new hostname resolves to the edge before its own CNAME is
visible, and the edge routes that record once it lands. Without it
the name would answer NXDOMAIN, which resolvers cache for the zone's
negative TTL (30 minutes on Cloudflare), failing the device's
readiness probe that long. A name with no record of its own must
answer no status below 500, which the probe reads as not routable
yet: `curl -m 10 https://<any-name>.shigomori.link` times out or
answers 5xx. Devices need nothing installed: the app bundles a
pinned `cloudflared`
(`shared/packaging/cloudflaredDist.mts`, fetched at package time and by
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
when running `pnpm run package` / `pnpm run make` in `app/` and they are baked into
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
  app-local clients are admitted. Unlike the device hub, this
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

A machine with no browser (`sm login` on a Linux server) signs in
through Clerk's device grant instead: the user approves a code on
Clerk's hosted page, and the host gets an OAuth access token that it
brings as the enroll bearer once. The Worker verifies it against the
JWKS as it does a session token, and accepts it only when it was
issued to the OAuth application named by the `CLERK_OAUTH_CLIENT_ID`
var (`wrangler.jsonc`, per environment). Without the var, no OAuth
token enrolls. The application is public, has the device
authorization grant on, and issues its access tokens as JWTs. The
Account Portal hosts the approval page, so it has to be on.

A desktop window no one sits at (the lab's, on a server's virtual
display) can sign in with the same code. Its shell brings the
access token to `POST /sign-in-token`, and the Worker answers a Clerk
sign-in token for the account (five minutes, one use), which the
window redeems (Clerk's `ticket` strategy) for a session of its own
and enrolls with as above.

One REQUIRED piece of Clerk instance configuration: the desktop
renderer lives on a custom-scheme origin and authenticates Clerk's
Frontend API with an `Authorization` header, which Clerk rejects from
an origin it does not know (`origin_authorization_headers_conflict`,
the same rule browser extensions hit). Add the renderer origins to
the instance's `allowed_origins` once per instance (prod's and dev's):

The PATCH replaces the whole list, so read it first and send it back
with the origin added. The dashboard's Native applications page does
not show the list; `GET /v1/instance` does:

```sh
curl -s https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" | jq '.allowed_origins'

curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" \
  -H "Content-type: application/json" \
  -d '{"allowed_origins": ["shigomori-dev://app"]}'
```

The second call's list is the first call's answer plus the new origin;
the one above is the dev instance's. Read it back the same way
afterwards. Without it, desktop sign-in fails on every Frontend API
call after the first (the web client is unaffected: a browser origin
authenticates the browser way).

A PRODUCTION instance additionally enforces an allowlist of OAuth
redirect URLs (development instances do not, so dev never trips it).
The desktop's `@clerk/electron` bridge sends the renderer origin plus
a trailing slash, and the sign-in modal reports "does not match an
authorized redirect URI" until it is listed. Add it once per production
instance, on the dashboard's Native applications page under the
mobile OAuth redirect allowlist, or with the API:

```sh
curl -X POST https://api.clerk.com/v1/redirect_urls \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" \
  -H "Content-type: application/json" \
  -d '{"url": "shigomori://app/"}'
```

Social (browser-redirect) sign-in works in `pnpm start`: the dev
launcher (scripts/lib/devBundle.mts) clones Electron.app into a
gitignored per-worktree bundle that claims `shigomori-dev://` with
LaunchServices, and runs the dev app from it, so the redirect
deep-links back to the running dev process. With several dev worktrees
the most recently launched one owns the scheme. The dev bundle
registers its own plist, so the packaged app's `shigomori://` registration
(forge.config.ts protocols) is not exercised by dev sign-in: verify
social providers against a packaged build before a release that
touches it.

The production web client deploys from the `web-client-prod` branch,
Vercel's production branch for the project (set up as "The Vercel
projects" says, below). The release workflow fast-forwards it to the
tagged commit at the end of every full (non-prerelease) release, once
the desktop assets are uploaded, so the web client ships the same
source as the `.app` without a push by hand.
A push by hand is still fine for a web-only fix between releases: the
workflow leaves a branch that is already past the tag alone, and goes
red rather than overwrite one that has diverged from it.

The web deploy's CSP (`app/vercel.json`) allowlists both Clerk script
hosts: `https://*.clerk.accounts.dev` for the development instance and
`https://clerk.shigomori.com`, the production (`pk_live`) instance's own
Frontend API host. One static file serves every Vercel environment, so
both stay listed.

For local development, put the account service values above in a gitignored
`.env.local` in `app/` (simple `KEY=value` lines). Both the
desktop and the web build read it. Baked and real environment variables
override it, and packaged builds never read it.

### The Vercel projects

The web client (`app`) and the marketing site (`marketing`, deployed
from `main`) are each a Vercel project that builds one folder of the
pnpm workspace at the repo root, whose dependencies take their versions
from the `catalog:` in `pnpm-workspace.yaml`. Each project's settings
hold what its folder's `vercel.json` can't:

- Root Directory: the folder, with "Include files outside the root
  directory" on, since the install and the build read the workspace
  root and `packages/`.
- The environment variable `ENABLE_EXPERIMENTAL_COREPACK=1`, so the
  install runs the pnpm the root `package.json` pins
  (`packageManager`).

Each `vercel.json` holds the install command, `pnpm install
--no-frozen-lockfile`, beside the build settings and the headers.

## Develop

From a fresh checkout, `pnpm install` at the repo root first (the hub
needs none of the root's `postinstall`).

```sh
pnpm run dev        # wrangler dev with local bindings
pnpm run typecheck
```

`pnpm run dev` serves the Worker on `http://localhost:8787` (loopback
only, and it fails rather than move when the port is taken) with its
own local database. It applies any pending migrations to that database
first, without asking, and passes a fixed `TICKET_SIGNING_KEY`, which
wins over one in `.dev.vars`. Enrollment also needs the development
Clerk instance's `CLERK_SECRET_KEY` in a local `.dev.vars`
(gitignored). Point the dev app at this Worker with
`SM_DEVICE_HUB_URL` (`app/lab/dev-app.md`, "Other tools").

## Adding a route

A route is an endpoint in the contract's `HttpApi`
(`packages/contracts/src/hubApi.ts`), in the group whose auth it
shares: the group's middleware checks the bearer, so a handler reads
its caller with `yield* HubDevice` and checks nothing itself. Its
handler goes in that group's `HttpApiBuilder.group(...)` in
`src/worker.ts`, and holds to the routes beside it:

- A device of another account reads as one that does not exist
  (`HubUnknownDeviceError`), so a route leaks nothing about foreign
  ids.
- A failure of the registry is `HubUnavailableError` with the route's
  `operation`, a literal the error's schema lists, so a new route adds
  its own (`unavailable("<operation>")`, which logs the cause). The
  auth tiers answer it too: `credential` when the device's credential
  could not be read, `enroll` when Clerk could not check a sign-in
  (`src/clerk.ts` tells that from a token Clerk refused).
- A device goes out through `toDeviceInfo`, with presence from
  `presenceOrNone`, so a hub object's hiccup reads as offline rather
  than failing the read.

