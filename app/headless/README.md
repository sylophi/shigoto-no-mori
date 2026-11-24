# headless

The host ([`../host`](../host)) without a shell around it, for a machine with no screen such as a Linux server reached over SSH. It runs the host entry point ([`../host/process/run.ts`](../host/process/run.ts)) in its own node process, serving the terminal `sm` over the loopback and the account's other devices over the device link. Those are where its projects are seen and driven.

- [`main.ts`](main.ts): process entry point. Enforces one host per flavor on the machine via a lock in its userData, rebuilds the environment from the login shell ([`../shared/shellEnv.ts`](../shared/shellEnv.ts)), and treats SIGTERM or SIGINT as a quit.
- [`facts.ts`](facts.ts): supplies the facts the Electron shell would otherwise pass to the host. A packaged build is a folder containing the bundle alongside the binaries it runs, and a dev run uses the binaries from the app's dist folders. In both, userData and logs live in the OS's standard app directories (`appFolders` in [`packages/engine/src/footprint.ts`](../../packages/engine/src/footprint.ts)).
- [`shell.ts`](shell.ts): implements the Shell service for this process. What a desktop shell would display is logged instead, a restart quits so the service manager starts it again, and there is no window.
- [`updater.ts`](updater.ts): runs the app's updater ([`../shared/updater/machine.ts`](../shared/updater/machine.ts)) in this process. Because nobody is present locally to confirm a busy restart, it refuses one just as it does for another device. Installing an update puts the staged version in place and quits so the unit starts the new version.
- [`account.ts`](account.ts): handles the account without a window to sign in from. `sm login` asks Clerk for a device code and enrolls with the access token Clerk issues once the code is approved (the device grant in [`../ACCOUNT.md`](../ACCOUNT.md)). Because a server has no keyring, the credential is stored in an owner-only file.
- [`nuke.ts`](nuke.ts): implements `sm nuke` without a window. The command removes the service unit and starts the host with `--sm-nuke`, which runs the host's half of the nuke and leaves a marker. On the next startup, the files named in the marker are deleted ([`../shared/nuke.ts`](../shared/nuke.ts)), including the install itself.

`pnpm headless` (run from `app/`) builds the binaries and the bundle ([`../scripts/build-headless.mts`](../scripts/build-headless.mts), writing to `dist-headless/host.cjs`) and runs it as the dev flavor, which `smd` connects to.

## Packaging and the install

`pnpm package:linux` ([`../scripts/package-linux.mts`](../scripts/package-linux.mts), Linux x64 only) builds the release's Linux asset at `out/make/<configDir>-linux-x64-<version>.tar.gz`. The tarball contains a single folder with:

- the bundle, `host.cjs`
- the pinned `node` binary it runs on ([`../shared/packaging/nodeDist.mts`](../shared/packaging/nodeDist.mts))
- node-pty, with its addon compiled at install ([`../scripts/prepare-node-pty.mts`](../scripts/prepare-node-pty.mts))
- `sm`, `nativefs`, `file-sync`, and `cloudflared`
- license notices for what it ships, in `licenses/`

Setting `SM_FLAVOR` builds a test flavor's package, as for the app. The release workflow builds on the oldest runner it has, because the addon and the file-sync engine run only on the glibc version they were built against or a newer one.

An install ([`install.sh`](../../install.sh) at the repo root, or the updater) stores each version's folder under `<XDG_DATA_HOME>/<configDir>/versions/`. The `current` symlink points to the active version, and `sm` is symlinked into `~/.local/bin` through `current` ([`packages/engine/src/linuxInstall.ts`](../../packages/engine/src/linuxInstall.ts)). `sm service` installs the systemd user unit that runs `current`'s host from boot ([`packages/engine/src/hostUnit.ts`](../../packages/engine/src/hostUnit.ts)). During an update, the updater checks the download against the digest GitHub stores for the release asset, unpacks it beside the existing versions, and flips `current` in a single rename ([`packages/engine/src/updater/versions.ts`](../../packages/engine/src/updater/versions.ts)), so a crash leaves either version intact.
