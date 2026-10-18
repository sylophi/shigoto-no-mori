# Page walks

A page walk proves a page the way a person meets it: the packaged
`lab` build, started on real git repos, its window clicked through,
and both what the window shows and what git did checked after each
step. A test of the engine alone, the dev app, the terminal command or
a request file is not what a user runs, so a user-facing path is
proved here as well.

```sh
SM_FLAVOR=lab pnpm -C app package   # once per change to the app
pnpm walks                          # every walk, about 30 s
pnpm walks changes                  # the walks whose file names match
```

Each walk starts a fresh app on a temp root of its own, removed
afterwards. The root holds a home with a git identity, a fake `gh`
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
  macOS runner and runs every walk: about 2 minutes of walks and 3 of
  packaging, too long for every pull request. It can also be started
  by hand (`workflow_dispatch`). A regression shows within the hour
  after a merge and before any cut.
- **Before every prerelease cut**, as the packaged check
  (`V3.md`, Process), on the build about to be cut.
- **By hand**, with `pnpm walks`, for a change that touches a page.

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
  symlink.
- `lib/labApp.mts` starts the build (`bootLab`, with `--sm-lab`, so
  the page's api is there for a walk that needs it). It hands back
  the page, `git` for the walk's repos, `sm` for the bundle's
  terminal command, and `restart`, which quits the app as the menu's
  Quit does and starts it again on the same root. `gh` takes a script, or a function of the root
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
| `host-restart` | The host killed, then stopped until the watchdog restarts it: the band says it is reconnecting and why it restarted, no error toast, and the page reads the new host's state. The window's timers stopped past every link limit, and the whole app stopped as a sleep stops it with a commit sent as it stopped: no band, no toast, no restart, and the commit lands once. About 4 minutes |
