# The guide's how-tos

`pnpm guide-eval` asks the guide twenty questions a new user would ask, running them through both Claude Code and Codex, and reports how each agent performed. Both CLIs must be installed and signed in, and running the eval consumes their tokens.

```sh
pnpm guide-eval                      # every how-to, both agents
pnpm guide-eval --harness codex      # one agent
pnpm guide-eval --only 5,11          # some how-tos, by number
```

The runner starts a fresh, signed-out dev profile named `<tag>-guide-eval` (`--tag` defaults to this checkout's folder name) with one project and one worktree.

For each how-to, the runner reloads the window and launches the agent the same way the Help menu item does (`guide:start`, which opens the agent in Terminal on its own session). It then closes the interactive agent it opened and runs headlessly on that session, combining the launch line the app typed with each CLI's non-interactive flags (`claude -p` or `codex exec`) and the how-to's question phrased as a user would type it. A how-to passes when the window shows the guide pointing at a control whose name answers the question (`HOW_TOS` in [`run.mts`](run.mts)).

For each agent, the report prints the pass rate and medians for a tour's time to first action, time to first point, total duration, token usage (total and output), and the round-trip time of `look` and `screenshot` through `sm guide mcp`. Action timings come from the shell's trace (`Guide.drive` spans), and points come from the window. Detailed per-run results go to `report/tours.json`, and app output goes to `report/app.log`.
