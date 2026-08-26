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

Optional var: set `ALLOWED_WEB_ORIGIN` to the exact origin of the
future web client. Unset, only Origin-less clients (the desktop app)
are accepted.

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
