# Cutting a prerelease

The `Release` workflow (`../.github/workflows/release.yml`) builds, signs,
notarizes and smokes a release once it is published. These gates come
first, on the machine that cuts, at the tip about to be tagged and in
this order. A failure at any of them stops the cut.

## 1. The tip as a packaged lab build

From `app/` (`dev-app.md`, "Packaged build, as a test flavor"):

```sh
SM_FLAVOR=lab pnpm package
node scripts/smoke-app.mts "out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app" --serve 9341
"out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app/Contents/Resources/smlab" nuke --yes
```

While the smoke serves, check with weblab attached to `127.0.0.1:9341`
the first run, a terminal and the pages the cut changes. A page that
needs an account is checked on a dev profile instead: Clerk's dev
instance refuses a test flavor's origin.

## 2. The installed prerelease takes the tip through "Restart to update"

The previous prerelease, installed on this machine and signed in, takes
the tip through Settings' "Restart to update" and comes back on it,
signed in. The tip has no release until it is tagged, and the release
job builds only once one is published, so the installed app is offered
a local build of it. From `app/`, with the signing identity set for
both the package and the smoke:

```sh
export APPLE_SIGNING_IDENTITY="<the Developer ID Application identity>"
```

1. Set the version to the installed one's `.1` (`3.0.0-beta.2.1` over
   `beta.2`, so the tag cut after it is still an update), without
   committing it: `pnpm pkg set version=<installed>.1`.
2. Package it as the release job would, on prod's account config. With
   `APPLE_SIGNING_IDENTITY` set, the package step fails unless the
   bundle comes out signed by it.

   ```sh
   SM_DEVICE_HUB_URL="$(gh variable get SM_DEVICE_HUB_URL)" \
   SM_ACCOUNT_CLERK_PUBLISHABLE_KEY="$(gh variable get SM_ACCOUNT_CLERK_PUBLISHABLE_KEY)" \
   SM_ACCOUNT_WEB_ORIGIN="$(gh variable get SM_ACCOUNT_WEB_ORIGIN)" \
   pnpm package
   ```

3. Once the installed app has made its first update check, about a
   minute after it starts:

   ```sh
   node scripts/smoke-app.mts "<the candidate .app>" --update-installed "<the installed .app>" "<its data folder>"
   ```

   Run it from the tip, unless `PROTOCOL_VERSION`
   (`../packages/contracts/src/protocol.ts`) differs between the tip
   and the installed version. Then run it from a checkout at
   `v<installed>`, its dependencies installed, on the same candidate:
   the smoke's press carries its checkout's protocol, and the installed
   app refuses any but its own.

4. Once it passes, the app it opened again runs on a normal launch's
   environment, launchd's, with nothing of the smoke's:

   ```sh
   ps -Ewwaxo command= | grep -F "<the installed .app>/Contents/MacOS/" | grep -v grep \
     | tr ' ' '\n' | grep -E '^(PATH|TMPDIR|SHIGOMORI_[A-Z_]+)='
   getconf DARWIN_USER_TEMP_DIR
   ```

   The first prints two lines, `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and
   `TMPDIR=` at the folder the second prints. An app left on the smoke's
   TMPDIR, a folder the smoke deletes, fails every temporary folder it
   makes. A smoke run from a checkout whose `smoke-app.mts` has no
   `openInstalled` (step 3's other-protocol case) leaves it so, which is
   no failure of the candidate's: quit the app, open it from the Dock,
   and read it again.

The smoke refuses before the app's first check, since `updater.json`
names the running app only from then, and leaves nothing behind. It
offers the candidate from a local release list, quits the app as the
menu's Quit does and opens it on that list, waits for the staged
update, and presses the button the way the window does
(`scripts/press-restart-to-update.mts`). It passes once the app is back
on the new version, by its bundle and by its own word in
`updater.json`, and the bundle's own `sm` answers `devices` signed in.
However it ends, the app is opened again on the real feed. Each start
it makes is through `open` with none of the smoke's environment, since
`open` hands the app it starts its caller's.

Then put the version back (`git checkout package.json`), tag the tip
and publish its release as a prerelease.
