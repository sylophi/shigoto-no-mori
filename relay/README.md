# sm relay

Cloudflare Worker that relays frames between a Clerk account's sm
devices when they are not on the same LAN (v2 step 4). Every device
holds one outbound websocket to its account's `AccountRelay` Durable
Object, which forwards opaque envelopes between them. No sm logic runs
here: the Worker verifies Clerk tokens, keeps a device registry in D1,
mints short-lived connection tickets and forwards frames it never
parses. The wire contract lives in `../shared/relay/protocol.ts`.

This directory is a standalone pnpm project (like `cli/` is a
standalone Go module) with its own lockfile. Install and run its
scripts from `relay/`. One caveat on isolation: the shared contract it
imports (`../shared/relay/protocol.ts` and the `frames.ts` that file
re-exports) lives outside `relay/`, so its `zod` import resolves from
the repo-root `node_modules`, not `relay/node_modules`. Both installs
pin the same zod, so a repo-root install is a prerequisite for building
or deploying the shared half.

## Deploy

Prerequisites: a Cloudflare account, a Clerk application, and
`pnpm install` run in this directory.

1. Create the database and paste the printed id into the
   `database_id` placeholder in `wrangler.jsonc`:

   ```sh
   pnpm exec wrangler d1 create sm-relay
   ```

2. Apply the migrations:

   ```sh
   pnpm exec wrangler d1 migrations apply sm-relay --remote
   ```

3. Set the Clerk secret key (from the Clerk dashboard, API keys):

   ```sh
   pnpm exec wrangler secret put CLERK_SECRET_KEY
   ```

4. Deploy:

   ```sh
   pnpm run deploy
   ```

Deploy order when a message cap shrinks (as with the 1 MiB to 64 KiB
`MAX_RELAY_MESSAGE_BYTES` change): update all devices BEFORE
redeploying the Worker. The devices' inbound socket bound stays
tolerant at the old cap for exactly this window, so a
not-yet-redeployed Worker forwarding an old peer's oversize frame does
not kill a new client's control-plane socket. The reverse skew (an old
app talking through a new Worker) degrades softly instead: its
oversize sends get nacked and the calls time out, which is acceptable
during the owner's own rollout.

Optional var: set `ALLOWED_WEB_ORIGIN` to the exact origin of the
future web client. Unset, only Origin-less clients (the desktop app)
are accepted. This var is PAIRED with the desktop app's
`SM_ACCOUNT_WEB_ORIGIN` (below): the Worker admits the web client's
relay traffic, and each desktop's direct listener separately admits
its direct dials. Set one without the other and web access only
half-works: with only `ALLOWED_WEB_ORIGIN`, web direct dials are
refused at every desktop's Origin gate (each host logs the refusal).

### Per-device tunnels (optional)

With the tunnel env configured, `POST /tunnel` provisions one named
Cloudflare Tunnel per device (v2 step 10, slice B): the Worker creates
or reuses the tunnel, points its remotely managed ingress at the
device's loopback direct listener, writes a proxied CNAME under
`TUNNEL_DOMAIN`, and returns the connector run token the app hands to
a local `cloudflared`. Tunnel data never touches the Worker. Unset,
the tunnel route answers a typed "not configured" and devices simply
skip tunnels.

Prerequisites: a DNS zone on the same Cloudflare account (for the
per-device CNAMEs), and an API token with Cloudflare Tunnel edit and
DNS edit permissions scoped to that account and zone. Devices need
`cloudflared` installed (`brew install cloudflared` on macOS, see
Cloudflare's docs for other platforms); the app finds it on PATH or
via the `cloudflaredPath` device config key.

1. Set the API token as a secret:

   ```sh
   pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN
   ```

2. Set the plain vars (in `wrangler.jsonc` `vars` or the dashboard),
   placeholders shown, use your own values:

   - `CF_ACCOUNT_ID` - the Cloudflare account id.
   - `TUNNEL_ZONE_ID` - the DNS zone id for the CNAMEs.
   - `TUNNEL_DOMAIN` - the tunnel parent domain inside that zone,
     e.g. `sm.example.com`.

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

- `SM_ACCOUNT_RELAY_URL` - the deployed Worker's base URL, e.g.
  `https://sm-relay.<account>.workers.dev`. The app joins the device and
  ticket routes onto this.
- `SM_ACCOUNT_CLERK_PUBLISHABLE_KEY` - the publishable key
  (`pk_test_...` / `pk_live_...`) of the same Clerk application whose
  secret key the Worker holds. The clients mount Clerk's embedded
  sign-in with it.
- `SM_ACCOUNT_WEB_ORIGIN` - optional, the exact origin of the deployed
  web client. MUST be set to the same value as the Worker's
  `ALLOWED_WEB_ORIGIN` whenever that is set: the two are one feature
  split across two processes. The desktop app's direct listener admits
  browser dials from exactly this origin so the web client can dial
  wss tunnel URLs; without it those dials die at the desktop's Origin
  gate (the host logs the refused origin, throttled). Unset, only
  Origin-less and app-local clients are admitted, as before.

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

One dev-only caveat: social (browser-redirect) sign-in cannot complete
in `pnpm start` on macOS — the redirect deep-links to
`shigomori-dev://app`, and LaunchServices won't route a scheme to the
unbundled dev Electron.app (only the packaged build registers its
scheme via Info.plist). Use email-code sign-in in dev; verify social
providers against a packaged build.

The web deploy's CSP (vercel.json) allowlists Clerk's script host as
`https://*.clerk.accounts.dev`, which covers development instances. A
production (`pk_live`) instance serves Clerk's UI from your own
`clerk.<domain>` Frontend API host instead — add that origin to
`script-src` when going live.

For local development, the app also reads a gitignored `.env.account`
file in the repo root if present (simple `KEY=value` lines). Baked and
real environment variables override it, and packaged builds never read
it.

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
