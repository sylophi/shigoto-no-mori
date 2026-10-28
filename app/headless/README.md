# headless

The host (`../host`) with no shell around it, for a machine with no
screen: a Linux server reached over SSH. It runs the host's run
(`../host/process/run.ts`) in its own node process, serving the
terminal `sm` on the loopback and the account's other devices on the
device link, which are where its projects are seen and driven.

- `main.ts`: the entry. One host per flavor on the machine (a lock in
  its userData), the environment rebuilt from the login shell
  (`../shared/shellEnv.ts`), and SIGTERM or SIGINT as a quit.
- `facts.ts`: the facts the Electron shell would hand the host: a
  packaged one is a folder holding the bundle beside the binaries it
  runs, a dev run's binaries are the app's dist folders, and its
  userData and logs are where the OS keeps an app's
  (`packages/engine/src/footprint.ts` appFolders).
- `shell.ts`: the Shell service over this process. What a shell would
  show is logged, a restart is a quit that the service manager starts
  again, and there is no window.
- `updater.ts`: the app's updater (`../shared/updater/machine.ts`) in
  this process. Nobody is at it to confirm a busy restart, so it
  refuses one as for another device. Its install puts the staged
  version in place and quits, and the unit starts the new one.
- `account.ts`: the account with no window to sign in from. `sm login`
  asks Clerk for a device code and enrolls with the access token
  Clerk issues once the code is approved (the device grant,
  `hub/README.md`). The credential is kept in an owner-only file,
  since a server has no keyring to keep it in.
- `nuke.ts`: `sm nuke` with no window. The command takes the unit out
  and starts the host with `--sm-nuke`, which runs the host's half of
  the nuke and leaves a marker. The next start deletes the files the
  marker names (`../shared/nuke.ts`), the install among them.

`pnpm headless` (from `app/`) builds the binaries and the bundle
(`../scripts/build-headless.mts`, into `dist-headless/host.cjs`) and
runs it as the dev flavor, which `smd` reaches.

## Packaging and the install

`pnpm package:linux` (`../scripts/package-linux.mts`, Linux x64 only)
builds the release's Linux asset, `out/make/<configDir>-linux-x64-<version>.tar.gz`.
The tarball holds one folder with:

- the bundle, `host.cjs`;
- the pinned `node` it runs on (`../shared/packaging/nodeDist.mts`);
- node-pty, its addon compiled at install (`../scripts/prepare-node-pty.mts`);
- `sm`, `nativefs`, `file-sync` and `cloudflared`;
- the notices of what it ships, in `licenses/`.

`SM_FLAVOR` makes a test flavor's package, as for the app. The release
workflow builds it on the oldest runner it has, since the addon and the
file-sync engine run only on the glibc they were built against, or a
newer one.

An install (`install.sh` at the repo root, or the updater) keeps each
version's folder under `<XDG_DATA_HOME>/<configDir>/versions/`. The
`current` link names the one that runs, and `sm` is linked into
`~/.local/bin` through `current`
(`packages/engine/src/linuxInstall.ts`). `sm service` installs the
systemd user unit that runs `current`'s host from boot
(`packages/engine/src/hostUnit.ts`). An update checks the download
against the digest GitHub keeps for the release asset, unpacks it
beside the others, and flips `current` in one rename
(`packages/engine/src/updater/versions.ts`), so a crash leaves either
version whole.
