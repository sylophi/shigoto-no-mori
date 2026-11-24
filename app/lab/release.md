# Cutting a prerelease

The `Release` workflow ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)) runs once a release is published. Its `tag` job checks the tag, then the macOS, Linux, and Windows builds run in parallel, each running a smoke test on what it built (with the macOS build signed and notarized). Its `attach` job adds their assets to the release only after all three builds pass. The Windows arm64 build is experimental: if it fails, the release goes out without it.

Run the two local gates below first on the machine cutting the release, at the exact tip commit about to be tagged and in this order. A failure at either gate stops the cut.

## 1. The tip as a packaged lab build

From `app/` ([`dev-app.md`](dev-app.md), "Packaged build, as a test flavor"):

```sh
SM_FLAVOR=lab pnpm package
node scripts/smoke-app.mts "out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app" --serve 9341
"out/Shigoto no Mori (lab)-darwin-arm64/Shigoto no Mori (lab).app/Contents/Resources/smlab" nuke --yes
```

While the smoke test serves, attach weblab to `127.0.0.1:9341` and check the first run, a terminal, and the pages changed by the cut. Check any page that needs an account on a dev profile instead, because Clerk's dev instance refuses a test flavor's origin.

## 2. The installed prerelease takes the tip through "Restart to update"

Verify that the previous prerelease, installed on this machine and signed in, updates to the tip through Settings' "Restart to update" and comes back on the new build while still signed in. Because the tip has no release until it is tagged and the workflow builds only after a release is published, offer the installed app a local build of the tip. From `app/`, export the signing identity so both the packaging step and the smoke script use it:

```sh
export APPLE_SIGNING_IDENTITY="<the Developer ID Application identity>"
```

1. Set the version to `<installed>.1` (for example, `3.0.0-beta.2.1` over `beta.2`, so the tag cut afterward still counts as an update), without committing it: `pnpm pkg set version=<installed>.1`.
2. Package the candidate as the release job would, using prod's account configuration. With `APPLE_SIGNING_IDENTITY` set, packaging fails unless the bundle comes out signed by that identity.

   ```sh
   SM_DEVICE_HUB_URL="$(gh variable get SM_DEVICE_HUB_URL)" \
   SM_DEVICE_HUB_APP="$(gh variable get SM_DEVICE_HUB_APP)" \
   SM_ACCOUNT_CLERK_PUBLISHABLE_KEY="$(gh variable get SM_ACCOUNT_CLERK_PUBLISHABLE_KEY)" \
   SM_ACCOUNT_WEB_ORIGIN="$(gh variable get SM_ACCOUNT_WEB_ORIGIN)" \
   pnpm package
   ```

3. Once the installed app has made its first update check (about a minute after it starts), run:

   ```sh
   node scripts/smoke-app.mts "<the candidate .app>" --update-installed "<the installed .app>" "<its data folder>"
   ```

   Run this from the tip checkout unless `CORE_VERSION` ([`packages/contracts/src/protocol.ts`](../../packages/contracts/src/protocol.ts)) or the `updater` module's version differs between the tip and the installed version. When either differs, run it from a checkout at `v<installed>` (with its dependencies installed) against the same candidate: the smoke script's button press sends its own checkout's core version, and the installed app refuses any core version other than its own.

4. After the smoke passes, verify that the relaunched app runs under a normal launchd environment with none of the smoke script's environment variables left behind:

   ```sh
   ps -Ewwaxo command= | grep -F "<the installed .app>/Contents/MacOS/" | grep -v grep \
     | tr ' ' '\n' | grep -E '^(PATH|TMPDIR|SHIGOMORI_[A-Z_]+)='
   getconf DARWIN_USER_TEMP_DIR
   ```

   The first command should print two lines: `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and `TMPDIR=` pointing to the folder printed by the second command. An app left on the smoke script's `TMPDIR` (a folder the smoke deletes) fails whenever it tries to create a temporary folder. A smoke run from an older checkout whose [`scripts/smoke-app.mts`](../scripts/smoke-app.mts) has no `openInstalled` (the protocol-mismatch case in step 3) leaves it that way, which is not a failure of the candidate: quit the app, reopen it from the Dock, and run the check again.

The smoke script refuses to run before the app's first update check (and leaves nothing behind), because `updater.json` records the running app only after that check. Otherwise, it serves the candidate from a local release list, quits the app just like the menu's Quit action, reopens it pointed at that list, waits for the staged update, and presses "Restart to update" the same way the window does ([`scripts/press-restart-to-update.mts`](../scripts/press-restart-to-update.mts)). It passes once the app comes back on the new version (confirmed both by its bundle and by what it writes to `updater.json`) and the bundle's own `sm` returns a signed-in response to `devices`. Regardless of outcome, the script reopens the app on the real feed. Every launch goes through `open` with the smoke script's environment stripped, because `open` otherwise passes its caller's environment to the app it starts.

Then restore the version (`git checkout package.json`), tag the tip, and publish its release as a prerelease.
