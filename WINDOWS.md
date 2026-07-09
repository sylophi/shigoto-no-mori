# Windows support

Windows support is **experimental**. It ships as an x64 build, follows documented Windows semantics throughout, and is exercised by an extensive automated test pass, but it has not yet had broad testing on real hardware. Expect rough edges and please report anything odd.

## Installing

Windows builds are portable: download the `-experimental` zip from [Releases](https://github.com/sylophi/shigoto-no-mori/releases), extract it into its own folder, and run `shigoto-no-mori.exe`. There is no installer and nothing is written to the registry; delete the folder to uninstall (your projects and settings under `~/shigomori` are untouched).

- The build is currently unsigned, so SmartScreen will warn on first run (More info > Run anyway).
- There is no auto-update on Windows: to update, download a new zip and replace the folder.

## Requirements

- Git for Windows, installed and on PATH.
- Symlink-mode carry-over entries need Developer Mode enabled (Settings > System > For developers); copy mode always works.

## Caveats

- Tools are discovered through the PATH that GUI apps see (the registry user PATH). Entries added per-session by shell profiles (e.g. `fnm env`) aren't visible, and installing a CLI like `gh` while the app is running needs an app restart to be picked up.
- Worktrees on network (UNC) paths can't run scripts or custom launchers; cmd.exe silently falls back to `C:\Windows` as the working directory there. Map the share to a drive letter instead.
- Deep worktree paths can exceed the legacy 260-character limit; enable long paths with `git config --global core.longpaths true`.
- Don't create directory junctions (`mklink /J`) inside worktrees: Git for Windows can recurse through a junction during `git worktree remove --force` and delete the junction's target. Carry-over links created by the app are real symlinks, which are safe.

## Developing on Windows

Use `pnpm run start:win`; the plain `start` script depends on the macOS-only port-pool tool.
