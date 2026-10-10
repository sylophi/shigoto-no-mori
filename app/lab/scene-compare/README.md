# Scene comparison

Shows what a change does to the app's look. Every scene
(`packages/ui/src/scenes`) is drawn in light and dark, each at the window
it draws (the desktop app, the web app on a phone, or a part), by the
working tree and by a base ref. Pairs that differ go in a report.

```sh
pnpm scenes:compare                      # against origin/release/v3
pnpm scenes:compare --base origin/main   # any ref git resolves
pnpm scenes:compare --threshold 50       # pixels a pair may differ by (20)
```

The base defaults to `origin/release/v3` while v3 is built there. Once
that branch is in main, the default becomes `origin/main`. Fetch first,
since the script compares against the ref as it stands locally.

It checks the base out into a temporary git worktree, installs it, starts
both fake hosts' servers on free ports, and drives the system's Chrome
(`playwright-core`, `channel: "chrome"`). Each scene loads from the
viewer (`/scenes.html?scene=<name>&theme=<theme>`). The shot is the
theme root, with reduced motion and animations off. A pixel counts as
changed when a channel moves by more than 16 of 255, and a pair differs
when more than the threshold of its pixels changed. The default of 20
sits above the anti-aliasing a font or a rounded edge shifts between two
runs. A change of size is a difference in every pixel. The base
checkout, the servers and the browser are all removed at the end,
Ctrl-C included.

**The terminal is masked.** Headless Chrome draws xterm's WebGL canvas
blank, so the comparison covers the terminal's canvas with a solid box
on both sides and still compares the rest of those scenes.

**The report** is `report/report.md` beside this file (gitignored). For
each differing pair it lists the changed pixel count and links three
images: the base, the head, and a diff with the changed pixels in red
over a faded base. It also lists scenes that exist on only one side,
which are not compared. The script exits 1 when a pair differs.

**In CI** it runs only on demand: the Scenes workflow
(`.github/workflows/scenes.yml`), from the Actions tab, takes the base as
its input and uploads the report as the `scene-comparison` artifact.
Nothing runs it on a commit or a pull request.

It takes about two and a half minutes on a laptop and ten on a GitHub
runner, whose first load of each server is slow.
