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
  again, and there is no updater or window.

`pnpm headless` (from `app/`) builds the binaries and the bundle
(`../scripts/build-headless.mts`, into `dist-headless/host.cjs`) and
runs it as the dev flavor, which `smd` reaches.
