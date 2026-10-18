# Page walks

A page walk proves a page the way a person meets it: the packaged
`lab` build, started on real git repos, its window clicked through,
and both what the window shows and what git did checked after each
step. A test of the engine alone, the dev app, the terminal command or
a request file is not what a user runs, so a user-facing path is
proved here as well.

```sh
SM_FLAVOR=lab pnpm -C app package   # once per change to the app
pnpm walks                          # every walk, about 7 minutes
pnpm walks changes                  # the walks whose file names match
```

Each walk starts a fresh app on a temp root of its own, removed
afterwards. A failed walk's root (its boot, a hook or a case failed)
is kept under `SM_WALK_FAILURES` when it is set, every one of this run
and the newest five of the runs before, and never inside a checkout,
whose typecheck would read its copy of the repo. It holds the
shell's `main.log` and trace under `home/Library/Logs`, and the host's
trace beside it in `host-logs`, which every walk of the run appends to.
CI keeps every walk's logs (`SM_WALK_LOGS`) and a failed walk's root,
and uploads them when one fails.

The root holds a home with a git identity, a fake `gh`
first on the login shell's PATH, and none of the user's shell hooks
(the app rebuilds its environment from `$HOME`'s startup files). It
also holds a data folder and the walk's repos, registered through the
bundle's own `smlab`. After the last walk, `smlab nuke --yes
--keep-app` takes the build's settings, logs and keychain item off the
machine. The bundle stays. That footprint is the lab build's on this
machine, whoever runs it, so the walks refuse to start while a lab
build is running. `SM_LAB_APP` points the walks at a build somewhere
else.

## Where they run

- **After every landing on release/v3**, in the `Walks` workflow
  (`.github/workflows/walks.yml`), which packages the lab build on a
  macOS runner and runs every walk: about 13 minutes of walks (the
  cross-device ones about 6 of that, where a laptop takes a minute and
  a half) and 1 of packaging, too long for every pull request. It checks out the whole
  history, since the cross-device walks' project is this repository
  at a pinned commit. It can also be started
  by hand (`workflow_dispatch`). A regression shows within the hour
  after a merge and before any cut.
- **Before every prerelease cut**, as the packaged check
  (`V3.md`, Process), on the build about to be cut.
- **By hand**, with `pnpm walks`, for a change that touches a page.

## Two devices, a real project

The cross-device walks (`cross-device.walk.mts`) run the lab build as
several devices of one account, on a real project with the owner's
settings, because the flows between devices broke on what a
generated repo and default settings never have (V3.md, the clone of a
remote-tracking default branch).

- **The devices** (`lib/devices.mts`): each is the lab build launched
  as a profile (`SHIGOMORI_PROFILE`, which a test flavor takes and a
  release build ignores), so each has its own userData,
  single-instance lock and hub credential, and its own root as every
  walk has. The walk adds them as it needs them: a device without the
  project is a fresh one.
- **The hub** (`lib/labHub.mts`): this checkout's worker under
  `wrangler dev` with local bindings, its config, build and state in a
  temp folder of its own, where a login is `lab:<account>` in place of
  a Clerk session token (`hub/src/lab.ts`). Each device enrolls through the page api with
  it. No network and no Clerk: the window logs that Clerk's UI didn't
  load, and nothing else of the account needs it. The devices reach
  each other directly on loopback, as two Macs on one network do.
- **The project** (`lib/realRepo.mts`): this repository at a pinned
  commit, 2,562 files and 1,076 commits, served by `git daemon` on
  loopback as the remote, so a clone from a peer carries it (a local
  path it would not). A device clones it as a laptop has it: the
  default branch `origin/main`, the owner's settings
  (`applyOwnerSettings`: carry-over copies of `CLAUDE.local.md`, ignored
  only by the user's own excludes, and `app/.env.local`; a setup
  script; squash), and worktrees made from `origin/main`.
- **The setup script** is a cheap one of the same shape as the owner's
  `pnpm install && pnpm run postinstall`: a real command that reads the
  tree and writes into the worktree's ignored `node_modules` in a few
  seconds. The owner's own takes minutes and gigabytes per worktree,
  which a run of a dozen worktrees can't spend; the hand sweep runs it.
- **What a walk fails with** is what the window says: a dialog that
  ends in its failure fails the walk with its words, so a broken flow
  reads as the error the person met.

## Adding one

A walk is `walks/<page>.walk.mts`, a vitest file:

```ts
let lab: Lab;
beforeAll(async () => {
  lab = await bootLab({ seed: (dir, git) => { repo = seedDemo(dir, git); } });
  await openPrimary(lab.page, "demo");
});
afterAll(() => lab?.close());

it("does what the person did", async () => {
  await main(lab.page).getByRole("button", { name: "…" }).click();
  await expect.poll(() => lab.git(repo, "log", "-1", "--format=%s").trim()).toBe("…");
});
```

- `lib/labApp.mts` starts the build (`bootLab`). It hands back the
  page, `git` for the walk's repos and `sm` for the bundle's
  terminal command. `gh` takes a script, or a function of the root
  that makes one. `linkedDataDir` puts the data folder behind a
  symlink. `debugPort` is the window's debugging port, for a weblab
  session attached to a walk held at a breakpoint.
- `lib/labApp.mts` starts the build (`bootLab`, with `--sm-lab`, so
  the page's api is there for a walk that needs it). It hands back
  the page, `git` for the walk's repos, `sm` for the bundle's
  terminal command, `restart`, which quits the app as the menu's
  Quit does and starts it again on the same root, and `followWindow`,
  the window drawn after the shell put up a new one. `gh` takes a script, or a function of the root
  that makes one.
- `lib/demoRepo.mts` is the repo most walks start from: a history
  with a long file and media, a bare origin, a branch with a commit
  of its own, a stash, and uncommitted changes of every kind. A walk
  adds what it needs in its own `seed`.
- `lib/fakeGitHub.mts` is a GitHub for pull-request walks: origin on
  github.com over ssh, served from a bare repo, and a `gh` that
  answers for one open pull request. It logs what else it is asked.
- `lib/page.mts` holds what walks read from the window: text through
  the diff renderer's shadow roots, which images, videos and players
  actually loaded, and what a terminal holds (`terminalText`, read
  from xterm's buffer, since it draws with WebGL).

Reach controls by their role and accessible name, scoped to `main(page)`
or `sidebar(page)`: a name matches as a substring, so "Create worktree"
also finds "Quick-create worktree in demo". Check git or the files
after an action, not only the window. Wait on the condition with
`expect.poll`, never on a set time. One app runs at a time, since a
build's single-instance lock is machine-wide.

## What is walked

| Walk | Pages and actions |
| --- | --- |
| `changes` | The changes page: every kind of change, an image's two sides, leaving a file out, a hunk's discard and its Undo, a commit, and the last-commit strip's undo and amend |
| `history` | A commit's page with an image, a video and a tone; a 1,500-line file drawn to its end; a branch's changes; the timeline's squash and hard reset; the merge dialog |
| `stashes` | The stash list and a stash's diff, stashing, a drop and its Undo, restore and keep |
| `files` | The files viewer: the tree, an image, a video, a tone, markdown, a long text file |
| `new-worktree` | A branch off a source; a source branch checked out as it is |
| `rename` | Renaming a worktree from its page: the folder moves and the window stays on the worktree's page |
| `location` | The Worktree location page with the data folder reached through a link: a worktree already in place is not offered a move |
| `appearance` | Settings > Appearance: a palette and a theme picked stay on the window until Discard, which puts back what is saved |
| `terminals` | A terminal from the worktree's footer runs what is typed; after the app quits as a person quits it and starts again, it is back in its folder with its lines above |
| `pull-request` | A pull request on its branch's page and its diff page with images, against the fake gh |
| `pull-request-partial` | A pull request whose commits can't be fetched: its diff from `gh pr diff`, each image saying once that it isn't here, with Try again, which draws them once the commits are reachable |
| `renderer-recovery` | A window whose renderer is SIGTERMed, then SIGKILLed, then every process under the app SIGTERMed at once: each time the window is back on its page and reads the repo, the host restarted too; a window the person closes stays closed |
| `cross-device` | Two devices and a real project: the other device's worktree read-only while its control is off, its actions once it is on; mirror to it and from it, send and bring, each into the project there at another path and into a device without it, cloned first; the clone on `main` at the remote's tip with `origin/HEAD` and the upstream on `origin/main`, the copy clean with its carried files, the source torn down after a transplant |
| `host-restart` | The host killed, then stopped until the watchdog restarts it: the band says it is reconnecting and why it restarted, no error toast, and the page reads the new host's state. The window's timers stopped past every link limit, and the whole app stopped as a sleep stops it with a commit sent as it stopped: no band, no toast, no restart, and the commit lands once. About 4 minutes |
