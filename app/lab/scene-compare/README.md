# Scene comparison

Shows how a change affects the app's appearance. Every scene in [`packages/ui/src/scenes`](../../../packages/ui/src/scenes) is rendered in light and dark themes, each at the window size it represents (the desktop app, the web app on a phone, or an individual part), once from the working tree and once from a base ref. Any pairs that differ go into a report.

```sh
pnpm scenes:compare                      # against origin/main
pnpm scenes:compare --base HEAD~1        # any ref git resolves: a branch, a tag, a SHA
pnpm scenes:compare --threshold 50       # pixels a pair may differ by (20)
```

Fetch first, because the script compares against the base ref as it exists locally.

The script checks out the base ref into a temporary git worktree and installs its dependencies (if the base ref's postinstall copies file icons via `copy-material-icons.mts`, the script runs that too, because installs run without lifecycle scripts). It starts both fake-host servers on free ports and drives system Chrome (`playwright-core`, `channel: "chrome"`). Each scene loads from the viewer (`/scenes.html?scene=<name>&theme=<theme>`) and captures the theme root with reduced motion enabled and animations disabled.

A pixel counts as changed when any channel moves by more than 16 out of 255, and a pair differs when more than the threshold of its pixels changed. The default threshold of 20 sits above minor anti-aliasing shifts on fonts or rounded edges between runs. Any change in dimensions counts as a difference in every pixel. The temporary base checkout, both servers, and the browser are all cleaned up at the end, including on Ctrl-C.

**The terminal is masked.** Headless Chrome renders xterm's WebGL canvas blank, so the comparison covers the terminal's canvas with a solid box on both sides while still comparing the rest of those scenes.

**The report** is written to `report/report.md` beside this file (gitignored). For each differing pair, it lists the changed pixel count and links three images: the base, the head, and a diff highlighting changed pixels in red over a faded base. It also lists scenes that exist on only one side, which are not compared. The script exits 1 when any pair differs.

**In CI**, it runs only on demand: trigger the Scenes workflow ([`.github/workflows/scenes.yml`](../../../.github/workflows/scenes.yml)) from the Actions tab with the base ref as its input, and it uploads the report as the `scene-comparison` artifact. Nothing runs it automatically on a commit or a pull request.

A run takes about two and a half minutes on a laptop and about ten minutes on a GitHub runner, where each server's first load is slow.
