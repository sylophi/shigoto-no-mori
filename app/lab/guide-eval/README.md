# The guide's how-tos

`pnpm guide-eval` asks the guide (`V3.md`, "The guide") twenty questions
a new user would, through Claude Code and Codex, and reports how it did.
It needs both CLIs installed and signed in, and it spends their tokens.

```sh
pnpm guide-eval                      # every how-to, both agents
pnpm guide-eval --harness codex      # one agent
pnpm guide-eval --only 5,11          # some how-tos, by number
pnpm guide-eval --openings 1         # fewer openings
```

It starts a fresh dev profile, `<tag>-guide-eval` (`--tag`, default
this checkout's folder name), with one project and one worktree, not
signed in. Every run launches the agent the way the Help menu's item
does (`guide:start`, which opens it in Terminal on a session of its
own), closes the agent it opened, and runs headless on that session:
the launch line the app types plus each CLI's flags for a run with no
one at it (`claude -p`, `codex exec`), from a freshly reloaded window.

For each agent it first runs the app's own opening (`--openings`
times, default 3). An opening passes when the agent asks the user
something and does nothing in the window but read it (`look`,
`screenshot`). Each how-to then starts the agent with its question,
which it answers without asking first, and passes when the window
shows the guide pointing at a control whose name answers it
(`HOW_TOS` in `run.mts`).

The report, per agent: the pass rate, the openings that asked first
and touched nothing and their time, a tour's time to its first action,
to its first point and to its end, its tokens (all of them, and the
output's), and the round trip of `look` and `screenshot` through
`sm guide mcp` (medians). The actions come from the shell's trace
(`Guide.drive` spans), the points from the window. Each run's detail
is in `report/tours.json`, and the app's output in `report/app.log`.
