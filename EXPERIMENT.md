# Experiment: `sm doctor`

Branch `exp/cli-doctor`. Scope: the Go CLI at `cli/` only.

## What this is

`sm doctor` is the "why is sm behaving weirdly" command: an integrity
check of the sm installation and its on-disk state root. It is
deliberately *not* worktree hygiene (merged branches, disk usage,
tidying old work) -- nothing here cares whether your work is finished,
only whether the machinery underneath it is intact.

It prints a grouped checklist with ok / warn / fail glyphs, one line of
explanation per finding and a concrete suggested fix underneath.
`--json` emits the same findings as a machine-readable document. The
exit code is 1 when anything failed, 0 otherwise (warnings included).

New files: `cli/cmd_doctor.go` (command, rendering, the `--fix`
driver), `cli/doctor_checks.go` (the checks), `cli/doctor_checks_test.go`.
Touched: `cli/main.go` (helpItem + commands table), `cli/output.go`
(one new painter, `redOut`). No new Go module dependencies.

## What it checks

**Environment**

- `git` present and at least 2.31 (the version `rev-parse
  --path-format=absolute` needs, which is how sm locates repos)
- `gh` present and authenticated (only the exit code of `gh auth
  status` is consulted -- its output has no business in sm's)
- the installed app bundle behind this binary, and whether its version
  matches the CLI's. A prod CLI is a symlink into
  `<bundle>/Contents/Resources`, so a mismatch means the `sm` on PATH is
  a stray copy that `sm update` will never carry along
- flavor (sm vs smd), version, and which state root is in effect,
  including whether `SHIGOMORI_ROOT` overrode it
- PATH shadowing: every `sm` on PATH, deduped by what it finally
  resolves to, so a symlink and its target don't read as a conflict
- the shell integration hook: installed, edited by hand, or an older
  vintage than this build writes (byte-compared against what `shell
  install` would write now)

**State root**

- the root exists, is a directory, and is writable
- `config.json` parses (a truncated one silently drops every global
  preference)
- `registry.json` parses and its `projects` array has the right shape
  (a malformed one makes sm forget every project, silently -- the single
  highest-value check here). An old-format root, which still keeps the
  registry inside `state.json`, is drained first so the check judges
  what sm will actually read
- stale advisory locks (`<file>.lock` older than the 10s lock protocol
  allows) left by a process that died holding one
- `updates/staging.pid` whose holder is dead, which makes `sm update`
  refuse to run
- `shelvedWorktrees` marks whose worktree id matches nothing on disk
- port-pool allocations pointing at directories that are gone, so the
  ports stay reserved forever

**Per project** (one `ok` line per healthy project; a dozen projects
would otherwise bury the real findings under a hundred green ticks)

- the registered path exists, is still a git repo, and is the repo's
  primary checkout -- with a separate, accurate message for the case
  where it was registered through a symlinked path (git always answers
  with a resolved path, and every match in sm is string equality
  against it)
- `project.json` present but invalid: both the app and the CLI treat it
  as absent, silently, so scripts and layout settings just stop applying
- the default branch resolves at all (otherwise `create` has no base)
- git's worktree metadata listing worktrees whose directory is gone
- the mirror image: directories sitting in the managed layout that git
  has no record of
- setup/teardown scripts naming a file that isn't in the repo
- `.worktreeinclude` present but unreadable, a directory, or failing to
  resolve

## `--fix`

Applies only repairs whose outcome is unambiguous:

| finding | repair | prompts? |
| --- | --- | --- |
| stale lock files | delete them | yes |
| dead update staging lock | delete it | yes |
| worktree metadata for a directory that's gone | `git worktree prune` | no |
| registry entry whose repo is gone | drop the entry + its state dir | yes |

`--yes` skips the prompts. Without a terminal to ask on, destructive
repairs are skipped with a note rather than assumed -- silence is not
consent. After any repair lands, the checks re-run so the printed
checklist describes the world *after* the fixes, not before.

Everything else is reported and never touched. A stray directory could
be a half-finished create, an adoptable external worktree, or something
you put there; a repo that stopped being a repo could want re-init or
unregistering. A doctor that guesses is worse than no doctor.

## Proof

All runs below are verbatim terminal output, ANSI stripped (the
painters no-op when stdout isn't a terminal). The binary was built with
the prod ldflags from `scripts/build-cli.mjs` so the prod-flavored
checks are exercised:

```
go build -C cli -trimpath -ldflags "-X main.version=0.22.5 -X main.flavor=prod \
  -X main.rootDirName=shigomori -X main.binaryName=sm -X main.aliasName=shigomori" -o /tmp/sm .
```

Both scratch roots come from `experiment-seed.sh`, which is committed
alongside this file: `./experiment-seed.sh healthy` and
`./experiment-seed.sh broken` each print the root they seeded. The runs
use seeded roots rather than the real `~/shigomori` so the transcripts
carry no home paths or personal project names -- the command was also
run read-only against the real root, which came back 20 ok / 2 warnings
with every project green.

The one warning both runs share is truthful: the binary is the freshly
built one in `/tmp`, not the copy inside the installed app bundle.

### A healthy root

```
$ ./experiment-seed.sh healthy
$ SHIGOMORI_ROOT=<that root> sm doctor
sm doctor 0.22.5 (prod)  root /private/tmp/sm-doctor-scratch.5J7aCY

Environment
  ✓  git         2.54.0 (Apple Git-157)
  ✓  gh          2.97.0, authenticated
  !  app         this binary isn't the one inside /Applications/Shigoto no Mori.app, so `sm update` can't reach it
    fix: Re-link the CLI from the app's Settings, or run /Applications/Shigoto no Mori.app/Contents/Resources/sm.
  ✓  PATH        ~/.local/bin/sm
  ✓  shell hook  installed for zsh (not active in this session)

State root
  ✓  root           /private/tmp/sm-doctor-scratch.5J7aCY (from SHIGOMORI_ROOT)
  ✓  config.json    valid, 1 key
  ✓  registry.json  valid, 2 projects registered
  ✓  locks          no stale lock files

Projects
  ✓  alpha  ok
  ✓  beta   ok

10 ok, 1 warning
exit=0
```

### A deliberately broken root

Seeded with: a truncated `config.json`; four registered projects, one
whose repo is gone, one that exists but was never a repo, one with a
`project.json` missing the required `defaultBranch`, one with a setup
script naming a file that isn't there; a worktree removed from disk but
still in git's metadata; a stray directory in the managed layout; two
locks with old mtimes; a `staging.pid` holding a dead pid.

```
$ ./experiment-seed.sh broken
$ SHIGOMORI_ROOT=<that root> sm doctor
sm doctor 0.22.5 (prod)  root /private/tmp/sm-doctor-scratch.0wwBMz

Environment
  ✓  git         2.54.0 (Apple Git-157)
  ✓  gh          2.97.0, authenticated
  !  app         this binary isn't the one inside /Applications/Shigoto no Mori.app, so `sm update` can't reach it
    fix: Re-link the CLI from the app's Settings, or run /Applications/Shigoto no Mori.app/Contents/Resources/sm.
  ✓  PATH        ~/.local/bin/sm
  ✓  shell hook  installed for zsh (not active in this session)

State root
  ✓  root            /private/tmp/sm-doctor-scratch.0wwBMz (from SHIGOMORI_ROOT)
  ✗  config.json     isn't valid JSON, so every global preference is silently ignored
    fix: Repair the JSON in /private/tmp/sm-doctor-scratch.0wwBMz/config.json, or delete it to fall back to defaults.
  ✓  registry.json   valid, 4 projects registered
  !  locks           /private/tmp/sm-doctor-scratch.0wwBMz/projects/AAAA1111/project.json.lock has been held for longer than a write can take (and 1 more)
    fix: Delete it (`sm doctor --fix`); the process that took it is gone.
  !  update staging  left behind by a crashed update (pid 999999 is gone), so `sm update` refuses to run
    fix: Delete /private/tmp/sm-doctor-scratch.0wwBMz/updates/staging.pid (`sm doctor --fix`).

Projects
  !  alpha       git still lists 1 worktree whose directory is gone (vanished)
    fix: Prune the metadata (`sm doctor --fix`, or `git worktree prune`).
  !  alpha       1 directory in the managed layout that git doesn't know about (/private/tmp/sm-doctor-scratch.0wwBMz/worktrees/alpha/stray-leftover)
    fix: Adopt it (`sm adopt <path>`) or delete it by hand -- sm won't guess.
  !  alpha       the setup script runs scripts/bootstrap.sh, which isn't in the repo
    fix: Fix it with `sm projects config --setup '<command>' -p alpha`.
  !  beta        project.json exists but is invalid (bad JSON or no defaultBranch), so its scripts and layout are ignored
    fix: Run `sm projects config --default-branch <ref> -p beta` to rewrite it.
  ✗  ghost       /private/tmp/sm-doctor-scratch.0wwBMz/repos/ghost-gone is gone, so every command for this project fails
    fix: Restore the directory, or unregister it (`sm projects remove ghost`).
  ✗  not-a-repo  /private/tmp/sm-doctor-scratch.0wwBMz/repos/not-a-repo is no longer a git repository
    fix: Restore the repo, or unregister it (`sm projects remove not-a-repo`).

6 ok, 7 warnings, 3 failed
4 of them can be repaired: run `sm doctor --fix`.
exit=1
```

### `--json`

The same findings as a document (trimmed here to the summary and the
first two non-ok checks):

```
$ SHIGOMORI_ROOT=<that root> sm --json doctor
{
  "binary": "sm",
  "summary": {
    "fail": 3,
    "ok": 6,
    "warn": 7
  },
  "checks": [
    {
      "group": "Environment",
      "id": "app",
      "title": "app",
      "status": "warn",
      "detail": "this binary isn't the one inside /Applications/Shigoto no Mori.app, so `sm update` can't reach it",
      "fix": "Re-link the CLI from the app's Settings, or run /Applications/Shigoto no Mori.app/Contents/Resources/sm."
    },
    {
      "group": "State root",
      "id": "config",
      "title": "config.json",
      "status": "fail",
      "detail": "isn't valid JSON, so every global preference is silently ignored",
      "fix": "Repair the JSON in /private/tmp/sm-doctor-scratch.0wwBMz/config.json, or delete it to fall back to defaults."
    }
  ]
}
```

### `--fix --yes` against the same broken root

Four repairs apply; everything with a judgment call in it survives,
and the checklist printed afterwards describes the world after the
repairs, not before.

```
$ SHIGOMORI_ROOT=<that root> sm doctor --fix --yes
sm doctor 0.22.5 (prod)  root /private/tmp/sm-doctor-scratch.0wwBMz

Environment
  ✓  git         2.54.0 (Apple Git-157)
  ✓  gh          2.97.0, authenticated
  !  app         this binary isn't the one inside /Applications/Shigoto no Mori.app, so `sm update` can't reach it
    fix: Re-link the CLI from the app's Settings, or run /Applications/Shigoto no Mori.app/Contents/Resources/sm.
  ✓  PATH        ~/.local/bin/sm
  ✓  shell hook  installed for zsh (not active in this session)

State root
  ✓  root           /private/tmp/sm-doctor-scratch.0wwBMz (from SHIGOMORI_ROOT)
  ✗  config.json    isn't valid JSON, so every global preference is silently ignored
    fix: Repair the JSON in /private/tmp/sm-doctor-scratch.0wwBMz/config.json, or delete it to fall back to defaults.
  ✓  registry.json  valid, 3 projects registered
  ✓  locks          no stale lock files

Projects
  !  alpha       1 directory in the managed layout that git doesn't know about (/private/tmp/sm-doctor-scratch.0wwBMz/worktrees/alpha/stray-leftover)
    fix: Adopt it (`sm adopt <path>`) or delete it by hand -- sm won't guess.
  !  alpha       the setup script runs scripts/bootstrap.sh, which isn't in the repo
    fix: Fix it with `sm projects config --setup '<command>' -p alpha`.
  !  beta        project.json exists but is invalid (bad JSON or no defaultBranch), so its scripts and layout are ignored
    fix: Run `sm projects config --default-branch <ref> -p beta` to rewrite it.
  ✗  not-a-repo  /private/tmp/sm-doctor-scratch.0wwBMz/repos/not-a-repo is no longer a git repository
    fix: Restore the repo, or unregister it (`sm projects remove not-a-repo`).

Repaired
  ✓ deleted 2 stale lock files
  ✓ deleted the stale update staging lock
  ✓ pruned git's worktree metadata for alpha
  ✓ unregistered ghost

7 ok, 4 warnings, 2 failed
exit=1
```

## What's rough

- **The interactive prompt path was never driven by hand.** `--fix`
  without `--yes` needs stdin *and* stderr to be terminals, which this
  session can't fake without a pty. The skip-without-consent and
  apply-with-`--yes` branches are covered by unit tests
  (`TestApplyRepairsSkipsDestructiveWithoutConsent`), and the
  non-interactive run was verified end to end, but nobody has actually
  typed `y` at it.
- **The port-pool check parses `port-pool list`'s human output.** It is
  tolerant (an unrecognized line is skipped, so a format change degrades
  to "no allocations found" rather than a wrong diagnosis), but it is
  still a text parse of another tool's UI. Reading port-pool's own
  `state.json` would be sturdier and is what a real version should
  probably do -- at the cost of coupling to a path that tool owns.
- **The app-version check shells out to `defaults read`.** `Info.plist`
  is binary and the alternative is a plist parser; a non-darwin build
  just gets "" and reports nothing.
- **The missing-script-file heuristic is deliberately shy.** It only
  flags tokens that unambiguously name a repo-relative file (a slash, no
  shell syntax, no variable, no URL). `bash $SETUP/x.sh` and
  `make setup` are invisible to it. False alarms in a doctor are worse
  than misses, but it does mean the check is easy to slip past.
- **The shelved-marks check bails entirely when any project's worktrees
  can't be listed.** That's correct (unlistable project => its ids look
  orphaned => false alarms), but it means the check silently produces no
  line at all in exactly the roots most likely to need it. Visible in
  the broken run above.
- **`--fix` re-runs every check after repairing**, including the ones
  that shell out to git and gh. On a root with many projects that's a
  second full pass; a cheaper design would re-check only what changed.
- **`checkStateRoot` returns early when the root itself is unusable**,
  so a broken root hides every state finding behind one line. Intended,
  but it means the checklist length varies more than it looks.
- No check for `updater.json` pointing at a live-but-wrong app, and
  none for the iconCache. Neither has ever been the cause of a "why is
  sm weird" report.

## Build / vet / test

```
$ go build -C cli ./...        # clean
$ go vet -C cli ./...          # clean
$ go test -C cli ./...
ok  	cli	0.691s              # all tests pass, 23 of them new
```

The new tests seed their own temp state roots (and temp git repos where
one is needed) and never read or write the real `~/shigomori`. No
`--fix` was ever run against the real root at any point in this
experiment.
