# The account service

Signing in, enrolling a device and the account's device list run on a
[Colibrii](https://github.com/sylophi/Colibrii) instance, through
`@colibrii/sdk`, with sign-in itself on a Clerk instance. Colibrii's
`service/README.md` documents the instance: setting one up, adding an
app to it, and running one locally. This page is what the app needs
from both.

## Build settings

The account is configured by five non-secret values
(`packages/contracts/src/accountServiceConfig.ts`):

- `SM_DEVICE_HUB_URL`: the Colibrii instance's address,
  `https://hub.colibrii.link`.
- `SM_DEVICE_HUB_APP`: the app's id on that instance, `shigomori` for
  production builds and `shigomori-dev` for dev.
- `SM_ACCOUNT_CLERK_PUBLISHABLE_KEY`: the publishable key (`pk_test_...`
  / `pk_live_...`) of the Clerk instance that app is registered with.
  Both clients mount Clerk's embedded sign-in with it.
- `SM_ACCOUNT_WEB_ORIGIN`: optional, the exact origin of the deployed
  web client. A desktop's direct listener admits browser dials from
  this origin alone, so the web client can reach it over its tunnel.
  Unset, only Origin-less and app-local clients are admitted. The gate
  stays exact because it guards a listener on the user's own machine,
  which any page they visit can reach.
- `SM_ACCOUNT_CLERK_OAUTH_CLIENT_ID`: optional, the Clerk OAuth
  application that signing in with a code goes through (below).

A packaged build takes them from the environment at build time, when
`pnpm run package` or `pnpm run make` runs: they are baked into the
bundle (`vite.node.config.ts`, `vite.web.config.ts`), because an app
launched from Finder or the Dock inherits launchd's environment, not a
shell's. The release workflow bakes them from the repository's Actions
variables. On the desktop and the headless host, variables present at
launch override the baked values. A build made without the first three
shows the account as not configured, with sign-in off. None of them are secrets, so they are
safe to bake into a build.

In development they come from a gitignored `.env.local` in `app/`
(`KEY=value` lines), which both the desktop and the web build read and
packaged builds never do (`lab/dev-app.md` has the dev values).

## Signing in

Both clients mount Clerk's `ClerkProvider` with the publishable key:
the desktop over `@clerk/electron`'s main-process bridge, the web
client with plain `@clerk/react`. Once Clerk reports a session, the
client mints a session token and enrolls the device with it. Colibrii
checks the token with the Clerk instance's public key, against the
origins the app is registered with, so the app's entry on the instance
lists the desktop window's origin (`shigomori://app`, or
`shigomori-dev://app` for dev) and the web client's.

A machine with no browser (`sm login` on a Linux server) signs in with
a code instead, through Clerk's device authorization grant: the user
approves the code on Clerk's hosted page, and the device enrolls with
the OAuth access token Clerk issues. This needs
`SM_ACCOUNT_CLERK_OAUTH_CLIENT_ID` and the same client id on the app's
Colibrii entry. Colibrii's README says how to set up that OAuth
application.

A desktop window no one sits at (the lab's, on a server's virtual
display) signs in with the same code, then trades the access token for
a Clerk sign-in token at the instance, which the window redeems
(Clerk's `ticket` strategy) for a session of its own. This needs the
Clerk secret key set as a secret on the instance, and the app's entry
there naming that secret.

## Clerk instance configuration

The desktop renderer lives on a custom-scheme origin and authenticates
Clerk's Frontend API with an `Authorization` header, which Clerk
rejects from an origin it does not know
(`origin_authorization_headers_conflict`). Add the renderer origin to
each instance's `allowed_origins` once, prod's and dev's. The
dashboard does not show the list, but `GET /v1/instance` does, and the
PATCH replaces the whole list, so read it first and send it back with
the origin added:

```sh
curl -s https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" | jq '.allowed_origins'

curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" \
  -H "Content-type: application/json" \
  -d '{"allowed_origins": ["shigomori-dev://app"]}'
```

The one above is the dev instance's. Read the list back afterwards.
Without it, desktop sign-in fails on every Frontend API call after the
first. The web client is unaffected: a browser origin authenticates
the browser way.

A production instance also enforces an allowlist of OAuth redirect
URLs. The desktop's `@clerk/electron` bridge sends the renderer origin
with a trailing slash, and the sign-in modal reports "does not match an
authorized redirect URI" until it is listed. Add it once, on the
dashboard's Native applications page under the mobile OAuth redirect
allowlist, or with the API:

```sh
curl -X POST https://api.clerk.com/v1/redirect_urls \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" \
  -H "Content-type: application/json" \
  -d '{"url": "shigomori://app/"}'
```

The renderer scheme's spelling comes from one place,
`shared/packaging/rendererScheme.mts`.

## Social sign-in in development

Social (browser-redirect) sign-in works in `pnpm start`: the dev
launcher (`scripts/lib/devBundle.mts`) clones Electron.app into a
gitignored per-worktree bundle that claims `shigomori-dev://` with
LaunchServices and runs the dev app from it, so the redirect deep-links
back to the running dev process. With several dev worktrees, the one
launched most recently owns the scheme. The dev bundle registers its
own plist, so the packaged app's `shigomori://` registration
(`forge.config.ts` protocols) goes untested by dev sign-in: check
social providers against a packaged build before a release that
touches it.
