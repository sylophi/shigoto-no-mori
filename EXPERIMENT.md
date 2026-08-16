# Experiment: `sm status`

A per-worktree status card for the Go CLI. `sm list` answers "what do I
have"; `sm status` answers "where does the worktree I'm standing in
stand".

## What it does

`cli/cmd_status.go` adds one command, registered in the help catalog and
the command table in `cli/main.go` (`status`, alias `st`, reachable as
`sm worktrees status` too, so `sm help status` works).

Addressing is the shared front door every other worktree command uses
(`resolveWorktreeArgs`): no argument means the worktree containing the
cwd, plus `<name>`, `<project>/<name>`, a path, `-p <project>`,
`root`/`primary`, and the app-plumbing `--worktree-id` / `--project-id`.

The card carries:

- project + worktree name, path, branch, and the primary / external /
  shelved / detached flags (same vocabulary as `list`'s flags cell)
- ahead/behind against the upstream, rendered through `list`'s
  `syncCell` colors, and ahead/behind against the project's base branch
  (the row is dropped when you're standing on the base branch itself,
  where it would only restate the upstream row)
- staged / unstaged / untracked / conflicted counts, split out of the
  single `changedCount` the table shows. Unmerged entries count as
  conflicted instead of being double-counted as staged + unstaged
- the repo's stash depth (git keeps one stack per repository, so the
  card says "repo-wide")
- the last commit: short sha, subject, relative age
- provisioned ports, read back out of the env files
  `port-pool.config.json` declares rather than out of port-pool's
  private state. Only whole-value templates (`"PORT": "${renderer}"`)
  can be reversed; a port name embedded in a bigger string goes
  unreported instead of guessed at
- the project's setup / teardown scripts, when configured
- the branch's PR via `gh`: number, title, state, draft, and a rolled-up
  check summary

Everything on the card is a read. The local git probes fan out
concurrently on top of `worktree.go`'s existing helpers; the PR lookup
is the only round-trip that leaves the machine, so it starts before them
and runs under a 6s deadline. Missing gh, unauthenticated gh, no
network, or a timeout all degrade to a dim one-line reason instead of
stalling the card. `--no-pr` skips the lookup entirely.

`--json` prints the whole card as one document, with the identity fields
keeping `worktreeJSON`'s names so a consumer can read a status card and
a list row with the same code.

## Proof

All runs used a scratch state root (`SHIGOMORI_ROOT=$(mktemp -d)`, seeded
with a copy of the real `state.json` / project configs) and read-only git
and gh commands. Nothing under `~/shigomori` was touched. The binary was
built from this branch, so it identifies itself as `smd` (dev flavor).
Home directories in the output below are redacted to `$HOME`; everything
else is verbatim, ANSI stripped by piping.

```
$ sm status
shigoto-no-mori/bubbly-mouse
  path     ~/shigomori/worktrees/shigoto-no-mori/bubbly-mouse
  branch   exp/cli-status  local
  base     origin/main  ↓2
  changes  4 staged
  commit   e158ef8  Point port-pool link at dittofleet org (#146)  (1h ago)
  ports    renderer 4170
  setup    pnpm install
  pr       none
```

```
$ sm --json status | python3 -m json.tool
{
    "id": "52b5bdc84a64",
    "projectId": "B88E5F97-EB1B-44F6-1019-6C1DAB459778",
    "projectName": "shigoto-no-mori",
    "name": "bubbly-mouse",
    "branch": "exp/cli-status",
    "path": "$HOME/shigomori/worktrees/shigoto-no-mori/bubbly-mouse",
    "isPrimary": false,
    "isExternal": false,
    "detached": false,
    "shelved": false,
    "git": {
        "upstream": null,
        "base": {
            "ref": "origin/main",
            "ahead": 0,
            "behind": 2
        },
        "staged": 4,
        "unstaged": 0,
        "untracked": 0,
        "conflicted": 0,
        "changedCount": 4,
        "stashCount": 0,
        "lastCommit": {
            "hash": "e158ef8",
            "subject": "Point port-pool link at dittofleet org (#146)",
            "author": "Harper",
            "date": "2026-08-15T20:15:14-07:00",
            "additions": 1,
            "deletions": 1
        }
    },
    "ports": [
        {
            "name": "renderer",
            "port": 4170,
            "file": ".env",
            "key": "PORT"
        }
    ],
    "portPool": {
        "enabled": true,
        "installed": true,
        "configured": true
    },
    "scripts": {
        "setup": "pnpm install"
    },
    "pr": null
}
```

Every addressing form:

```
$ sm status chirpy-raccoon
shigoto-no-mori/chirpy-raccoon
  path     ~/shigomori/worktrees/shigoto-no-mori/chirpy-raccoon
  branch   sm-config-commands  local
  base     origin/main  ↓4
  changes  9 unstaged, 2 untracked
  commit   f36642b  Add the sm-teardown skill (#145)  (20h ago)
  ports    renderer 3160
  setup    pnpm install
  pr       none

$ sm status shigoto-no-mori/mellow-ermine
shigoto-no-mori/mellow-ermine
  path     ~/shigomori/worktrees/shigoto-no-mori/mellow-ermine
  branch   exp/cli-jump  local
  base     origin/main  ↓2
  changes  5 unstaged, 2 untracked
  commit   e158ef8  Point port-pool link at dittofleet org (#146)  (1h ago)
  ports    renderer 6278
  setup    pnpm install
  pr       none

$ sm status root
shigoto-no-mori/shigoto-no-mori  (primary)
  path     ~/Software/app/shigoto-no-mori
  branch   main  ↓2
  changes  clean
  commit   e158ef8  Point port-pool link at dittofleet org (#146)  (1h ago)
  ports    renderer 5182
  setup    pnpm install
  pr       none

$ sm status peppy-tortoise -p Celery
Celery/peppy-tortoise
  path     ~/shigomori/worktrees/Celery/peppy-tortoise
  branch   celeste-theme  local
  base     origin/main  ↓3
  changes  19 unstaged
  commit   6e50c59  Celery: dependency-aware Celeste mod manager (#…  (2d ago)
  setup    pnpm install
  pr       none

$ sm status ../soft-capybara
shigoto-no-mori/soft-capybara
  path     ~/shigomori/worktrees/shigoto-no-mori/soft-capybara
  branch   configurable-data-root  local
  base     origin/main  ↓7
  changes  20 unstaged, 6 untracked
  commit   c181dbd  Add sm run: run package.json scripts from the C…  (4d ago)
  ports    renderer 6997
  setup    pnpm install
  pr       none
```

Degrading when gh can't answer (the local half of the card is
unaffected, and the ports still resolve because they come from the env
files, not from port-pool):

```
$ sm status --no-pr
shigoto-no-mori/bubbly-mouse
  path     ~/shigomori/worktrees/shigoto-no-mori/bubbly-mouse
  branch   exp/cli-status  local
  base     origin/main  ↓2
  changes  4 staged
  commit   e158ef8  Point port-pool link at dittofleet org (#146)  (1h ago)
  ports    renderer 4170
  setup    pnpm install

$ env PATH=/usr/bin:/bin sm status
shigoto-no-mori/bubbly-mouse
  ...
  pr       unavailable (gh isn't installed)

$ GH_TOKEN=bogus sm status
shigoto-no-mori/bubbly-mouse
  ...
  pr       unavailable (gh isn't authenticated)
```

Errors follow the existing conventions:

```
$ sm status nope
smd: No worktree named "nope".
exit=1

$ sm --json status nope
{"error":"No worktree named \"nope\".","ok":false}
exit=1
```

Help:

```
$ sm status --help          # identical to `sm help status`
Usage: smd worktrees status [<name>] [--no-pr]
  Status card for one worktree
  The worktree you're standing in, at a glance: how the branch sits against its
  upstream and the project's base branch, staged/unstaged/untracked counts, the
  repo's stash depth, the last commit, provisioned ports, the lifecycle scripts
  it would run, and the branch's PR with its checks. The PR lookup needs gh,
  runs under a short deadline, and degrades to a note instead of stalling the
  card (--no-pr skips it). --json prints the whole card as one document.

Run `smd --help` for the full list.
```

Wall time for the default run, gh probe included: ~0.67s.

## Build, vet, test

```
$ go build -C cli ./...   # clean
$ go vet -C cli ./...     # clean
$ go test -C cli ./...
ok  	cli	0.213s
```

`cli/cmd_status_test.go` covers the parts worth pinning: porcelain
classification (including the conflict cases), the dotenv parse and the
port reverse lookup (missing files, non-numeric values, deterministic
ordering across env files), the gh check rollup, the gh failure-reason
fold, relative ages, rune truncation, base-branch detection, and two
whole-card renders (all rows present; PR row skipped / absent).

## What's rough

- **No PR was rendered against a live repo.** No worktree on this
  machine currently has an open PR, so the PR row and the check rollup
  are only proven by unit tests (`TestPRLine`, `TestRollupChecks`). The
  gh call itself is exercised: the "none" rows above are real `gh pr
  list` round-trips that came back empty.
- **The check rollup is a summary, not a list.** It counts
  passing/failing/pending. Naming the failing check would be more useful
  and costs nothing extra in the same gh call.
- **`gh` is spawned per invocation with no caching.** Six seconds is a
  ceiling, not a typical cost (~300-500ms here), but `sm status` in a
  loop over many worktrees would pay it every time.
- **Ports only resolve for whole-value templates.** A project that
  writes `API_URL=http://localhost:${api}` and nothing else gets an
  empty ports row even though the port is allocated. Reading port-pool's
  own state file would cover that, at the cost of depending on its
  internals.
- **Stash counts are repo-wide**, since git keeps one stack per
  repository. The card labels it, but it can't tell you which worktree a
  stash came from.
- **`syncCell` in `cmd_list_path.go` was refactored** to delegate to the
  new `divergenceCell`, so the card and the table can't drift. That's a
  small edit to a file outside this experiment's new code.
- Setup/teardown status is "what is configured", not "what last ran" --
  the CLI keeps no run history, and the app's script registry lives in
  its own process.
