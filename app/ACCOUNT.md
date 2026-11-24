# The account service

Signing in, enrolling a device, and managing the account's device list run on a [Colibrii](https://github.com/sylophi/Colibrii) instance through `@colibrii/sdk`, with sign-in itself handled by a Clerk instance. Colibrii's `service/README.md` documents how to set up an instance, add an app to it, and run one locally. Below is what the app needs from both services.

## Build settings

The account service is configured by five non-secret values ([`packages/contracts/src/accountServiceConfig.ts`](../packages/contracts/src/accountServiceConfig.ts)):

- `SM_DEVICE_HUB_URL`: the Colibrii instance's address, `https://hub.colibrii.link`.
- `SM_DEVICE_HUB_APP`: the app's id on that instance, `shigomori` for production builds and `shigomori-dev` for dev.
- `SM_ACCOUNT_CLERK_PUBLISHABLE_KEY`: the publishable key (`pk_test_...` / `pk_live_...`) of the Clerk instance that the app is registered with. Both clients mount Clerk's embedded sign-in with it.
- `SM_ACCOUNT_WEB_ORIGIN`: optional, the exact origin of the deployed web client. A desktop's direct listener admits browser dials from this origin alone so the web client can reach it over its tunnel. When unset, only Origin-less and app-local clients are admitted. The gate stays exact because it guards a listener on the user's own machine that any page they visit can reach.
- `SM_ACCOUNT_CLERK_OAUTH_CLIENT_ID`: optional, the Clerk OAuth application used when signing in with a code (see below).

A packaged build reads these values from the environment at build time when `pnpm run package` or `pnpm run make` runs, and bakes them into the bundle ([`vite.node.config.ts`](vite.node.config.ts), [`vite.web.config.ts`](vite.web.config.ts)). Baking is needed because an app launched from Finder or the Dock inherits launchd's environment rather than a shell's. The release workflow bakes them from the repository's Actions variables. On the desktop and the headless host, environment variables present at launch override the baked values. A build made without the first three values shows the account as not configured, with sign-in off. None of these five values are secrets, so they are safe to bake into a build.

In development, they come from a gitignored `.env.local` in `app/` (`KEY=value` lines). Both the desktop and web builds read `.env.local`, while packaged builds never do ([`lab/dev-app.md`](lab/dev-app.md) has the dev values).

## Signing in

Both clients mount Clerk's `ClerkProvider` with the publishable key: the desktop uses `@clerk/electron`'s main-process bridge, and the web client uses plain `@clerk/react`. Once Clerk reports a session, the client mints a session token and enrolls the device with it. Colibrii verifies the token using the Clerk instance's public key and checks it against the origins registered for the app, so the app's entry on the Colibrii instance must list both the desktop window's origin (`shigomori://app`, or `shigomori-dev://app` for dev) and the web client's origin.

A machine with no browser (`sm login` on a Linux server) signs in with a code instead, using Clerk's device authorization grant: the user approves the code on Clerk's hosted page, and the device enrolls with the OAuth access token that Clerk issues. This requires `SM_ACCOUNT_CLERK_OAUTH_CLIENT_ID` and the same client id on the app's Colibrii entry. Colibrii's README explains how to set up that OAuth application.

An unattended desktop window (such as the lab's window on a server's virtual display) signs in with the same code, then trades the access token for a Clerk sign-in token from the Colibrii instance and redeems that token (using Clerk's `ticket` strategy) for a session of its own. This requires setting the Clerk secret key as a secret on the Colibrii instance and naming that secret in the app's entry there.

## Clerk instance configuration

To Clerk, the desktop app is a native application, so Clerk rejects its requests (`native_api_disabled`) until the Native API is enabled on each instance (on the dashboard's Native applications page).

The desktop renderer runs on a custom-scheme origin and authenticates against Clerk's Frontend API with an `Authorization` header, which Clerk rejects from any unknown origin (`origin_authorization_headers_conflict`). Add the renderer origin to each instance's `allowed_origins` once, for both prod and dev. The dashboard does not show this list, but `GET /v1/instance` returns it, and PATCH replaces the entire list, so read it first and send it back with the origin added:

```sh
curl -s https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" | jq '.allowed_origins'

curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" \
  -H "Content-type: application/json" \
  -d '{"allowed_origins": ["shigomori-dev://app"]}'
```

The example above is for the dev instance. Read the list back afterwards to verify it. Without this entry, desktop sign-in fails on every Frontend API call after the first. The web client is unaffected because a browser origin uses standard browser authentication.

A production instance also enforces an allowlist of OAuth redirect URLs. The desktop's `@clerk/electron` bridge sends the renderer origin with a trailing slash, and the sign-in modal reports "does not match an authorized redirect URI" until it is listed. Add it once on the dashboard's Native applications page under the mobile OAuth redirect allowlist, or with the API:

```sh
curl -X POST https://api.clerk.com/v1/redirect_urls \
  -H "Authorization: Bearer <CLERK_SECRET_KEY>" \
  -H "Content-type: application/json" \
  -d '{"url": "shigomori://app/"}'
```

The renderer scheme's spelling is defined in one place: [`shared/packaging/rendererScheme.mts`](shared/packaging/rendererScheme.mts).

## Social sign-in in development

Social (browser-redirect) sign-in works under `pnpm start`: the dev launcher ([`scripts/lib/devBundle.mts`](scripts/lib/devBundle.mts)) clones Electron.app into a gitignored per-worktree bundle that registers `shigomori-dev://` with LaunchServices and runs the dev app from it, so the redirect deep-links back to the running dev process. With several dev worktrees, the one launched most recently owns the scheme. Because the dev bundle registers its own plist, dev sign-in does not test the packaged app's `shigomori://` registration (`protocols` in [`forge.config.ts`](forge.config.ts)). Check social providers against a packaged build before any release that touches protocol registration.
