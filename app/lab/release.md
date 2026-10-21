# Cutting a prerelease

The `Release` workflow (`.github/workflows/release.yml`) builds, signs,
notarizes and smokes a release once it is published. These gates come
first, on the machine that cuts, at the tip about to be tagged and in
this order. A failure at any of them stops the cut.

## 1. The tip's walks passed

The tip's latest `Walks` run (`walks.md`, "Where they run") passed.
Checked before anything else; only a yes lets the cut go on, and a run
still going is a no:

```sh
gh run list --workflow walks.yml --commit "$(git rev-parse HEAD)" --limit 1 \
  --json status,conclusion \
  --jq 'if .[0].status == "completed" and .[0].conclusion == "success" then "yes" else "no" end'
```

## 2. The tip as a packaged lab build

From `app/` (`dev-app.md`, "Packaged build, as a test flavor"):

```sh
SM_FLAVOR=lab pnpm package
pnpm walks
node scripts/smoke-app.mts "out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app" --serve 9341
"out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app/Contents/Resources/smlab" nuke --yes
```

While the smoke serves, weblab attached to `127.0.0.1:9341` covers what
no walk does yet (the first run, a terminal).

## 3. The installed prerelease takes the tip through "Restart to update"

The previous prerelease, installed on this machine and signed in, takes
the tip through Settings' "Restart to update" and comes back on it,
signed in. The tip isn't on GitHub until the tag, and the release job
builds only once a release is published, so the installed app is
offered a local build of it.

1. Set the version to the installed one's `.1` (`3.0.0-beta.2.1` over
   `beta.2`, so the tag cut after it is still an update), without
   committing it: `pnpm -C app pkg set version=<installed>.1`.
2. Package it as the release job would, on the prereleases' account
   config and signed. With `APPLE_SIGNING_IDENTITY` set, the package
   step fails unless the bundle comes out signed by it.

   ```sh
   SM_FLAVOR=v3 \
   SM_DEVICE_HUB_URL="$(gh variable get SM_PREVIEW_DEVICE_HUB_URL)" \
   SM_ACCOUNT_CLERK_PUBLISHABLE_KEY="$(gh variable get SM_PREVIEW_ACCOUNT_CLERK_PUBLISHABLE_KEY)" \
   APPLE_SIGNING_IDENTITY="<the Developer ID Application identity>" \
   pnpm -C app package
   ```

3. Once the installed app has made its first update check, about a
   minute after it starts, run with the identity still set:

   ```sh
   node app/scripts/smoke-app.mts "<the candidate .app>" --update-installed "<the installed .app>" "<its data folder>"
   ```

   Run it from the tip, unless `PROTOCOL_VERSION`
   (`packages/contracts/src/protocol.ts`) differs between the tip and
   the installed version. Then run it from a checkout at `v<installed>`
   on the same candidate: the smoke's press carries its checkout's
   protocol, and the installed app refuses any but its own.

The smoke refuses before the app's first check, since `updater.json`
names the running app only from then, and leaves nothing behind. It
offers the candidate from a local release list, quits the app as the
menu's Quit does and opens it on that list, waits for the staged
update, and presses the button the way the window does
(`scripts/press-restart-to-update.mts`). It passes once the app is back
on the new version, by its bundle and by its own word in
`updater.json`, and the bundle's own `sm` answers `devices` signed in.
However it ends, the app is opened again on the real feed.

Then tag and publish. The release job's own smoke checks the signed
bundle.
