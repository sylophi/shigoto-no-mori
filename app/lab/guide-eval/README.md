# The guide's how-tos

`pnpm guide-eval` asks the guide twenty questions a new user would,
through Claude Code and Codex, and reports how it did. It needs both
CLIs installed and signed in, and it spends their tokens.

```sh
pnpm guide-eval                      # every how-to, both agents
pnpm guide-eval --harness codex      # one agent
pnpm guide-eval --only 5,11          # some how-tos, by number
```

It starts a fresh dev profile, `<tag>-guide-eval` (`--tag`, default
this checkout's folder name), with one project and one worktree, not
signed in. Every run launches the agent the way the Help menu's item
does (`guide:start`, which opens it in Terminal on a session of its
own), closes the agent it opened, and runs headless on that session:
the launch line the app types plus each CLI's flags for a run with no
one at it (`claude -p`, `codex exec`) and the how-to's question, as the
person would type it, from a freshly reloaded window. A how-to passes
when the window shows the guide pointing at a control whose name
answers it (`HOW_TOS` in `run.mts`).

The report, per agent: the pass rate, a tour's time to its first action,
to its first point and to its end, its tokens (all of them, and the
output's), and the round trip of `look` and `screenshot` through
`sm guide mcp` (medians). The actions come from the shell's trace
(`Guide.drive` spans), the points from the window. Each run's detail
is in `report/tours.json`, and the app's output in `report/app.log`.
