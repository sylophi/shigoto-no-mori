# The guide's how-tos

`pnpm guide-eval` asks the guide (`V3.md`, "The guide") twenty questions
a new user would, through Claude Code and Codex, and reports how it did.
It needs both CLIs installed and signed in, and it spends their tokens.

```sh
pnpm guide-eval                      # every how-to, both agents
pnpm guide-eval --harness codex      # one agent
pnpm guide-eval --only 5,11          # some how-tos, by number
pnpm guide-eval --asks 1             # fewer Asks to time
```

It starts a fresh dev profile, `<tag>-guide-eval` (`--tag`, default
this checkout's folder name), with one project and one worktree, not
signed in. For each agent it first times the window's own Ask
(`--asks` times, default 3), which opens the agent in Terminal the way
the palette does, from the Ask to the agent's first action. Each
how-to then asks the same way for a session of its own, closes the
agent the Ask opened, and runs headless on that session: the launch
line the app types plus each CLI's flags for a run with no one at it
(`claude -p`, `codex exec`), from a freshly reloaded window.

A how-to passes when the window shows the guide pointing at a control
whose name answers it (`HOW_TOS` in `run.mts`).

The report, per agent: the pass rate, the Ask to the first action, a
tour's time to its first action, to its first point and to its end,
its tokens (all of them, and the output's), and the round trip of
`look` and `screenshot` through `sm guide mcp` (medians). The first
action's time comes from the shell's trace (`Guide.drive` spans), the
points from the window. Each tour's detail is in `report/tours.json`,
and the app's output in `report/app.log`.

Claude Code asks to trust the guide's folder the first time. The run
answers yes, and leaves that Ask out of the times.
